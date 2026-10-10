-- Migration 002: agent authentication and STK Push initiation (spec gh-5).
--
-- Brings a database at migration 001 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/002_auth_stk_initiation.sql
--
-- Legacy rows: existing stk_requests rows (written before this migration, all carrying a Daraja
-- CheckoutRequestID) become status ACCEPTED with a fresh surrogate stk_request_id; the constraint
-- names the settlement worker relies on (stk_requests_consumed_receipt_key) are kept. An
-- agent_code longer than 12 characters (Daraja AccountReference limit) aborts the migration with
-- the offending codes; shorten them and re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialise concurrent runs of this migration.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $migration$
DECLARE
    v_name TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002_auth_stk_initiation') THEN
        RAISE NOTICE '002_auth_stk_initiation already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001_settlement_pipeline') THEN
        RAISE EXCEPTION 'migration 001_settlement_pipeline must be applied before 002_auth_stk_initiation';
    END IF;

    -- ── users ───────────────────────────────────────────────────────────────
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

    -- ── sales_agents.agent_code <= 12 (Daraja AccountReference) ─────────────
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_agents_agent_code_length') THEN
        SELECT string_agg(agent_code, ', ') INTO v_name FROM (
            SELECT agent_code FROM sales_agents WHERE char_length(agent_code) > 12 ORDER BY agent_code LIMIT 10) d;
        IF v_name IS NOT NULL THEN
            RAISE EXCEPTION 'sales_agents.agent_code longer than 12 characters (first 10: %)', v_name
                USING HINT = 'Daraja AccountReference is at most 12 characters: shorten these codes, then re-run.';
        END IF;
        ALTER TABLE sales_agents ADD CONSTRAINT sales_agents_agent_code_length CHECK (char_length(agent_code) <= 12);
    END IF;

    -- ── new tables ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS user_credentials (
        user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        algorithm VARCHAR(20) NOT NULL CHECK (algorithm IN ('scrypt')),
        params JSONB NOT NULL,
        salt BYTEA NOT NULL,
        hash BYTEA NOT NULL,
        must_change BOOLEAN NOT NULL DEFAULT TRUE,
        one_time_expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        family_id UUID NOT NULL,
        token_hash VARCHAR(80) UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        family_expires_at TIMESTAMPTZ NOT NULL,
        rotated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_ip VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
    CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);
    CREATE INDEX IF NOT EXISTS refresh_tokens_revoked_idx ON refresh_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS auth_events (
        auth_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type VARCHAR(30) NOT NULL CHECK (event_type IN (
            'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED', 'REFRESH', 'REFRESH_FAILURE',
            'LOGOUT', 'PIN_CHANGED', 'PIN_CHANGE_FAILURE')),
        user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        phone_hash VARCHAR(80),
        ip VARCHAR(64),
        user_agent_hash VARCHAR(80),
        reason VARCHAR(60),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS auth_events_occurred_idx ON auth_events (occurred_at);

    -- ── stk_requests: surrogate key, lifecycle status, idempotency ──────────
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'stk_requests' AND column_name = 'stk_request_id') THEN
        ALTER TABLE stk_requests ADD COLUMN stk_request_id UUID;
        UPDATE stk_requests SET stk_request_id = gen_random_uuid();
        ALTER TABLE stk_requests ALTER COLUMN stk_request_id SET DEFAULT gen_random_uuid();
        ALTER TABLE stk_requests ALTER COLUMN stk_request_id SET NOT NULL;
        -- The old primary key was checkout_request_id; it becomes a nullable UNIQUE column.
        ALTER TABLE stk_requests DROP CONSTRAINT stk_requests_pkey;
        ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_pkey PRIMARY KEY (stk_request_id);
        ALTER TABLE stk_requests ALTER COLUMN checkout_request_id DROP NOT NULL;
        ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_checkout_request_id_key UNIQUE (checkout_request_id);
    END IF;

    -- Legacy rows all carry a Daraja CheckoutRequestID: they were accepted.
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS status VARCHAR(12);
    UPDATE stk_requests SET status = 'ACCEPTED' WHERE status IS NULL;
    ALTER TABLE stk_requests ALTER COLUMN status SET DEFAULT 'PENDING';
    ALTER TABLE stk_requests ALTER COLUMN status SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stk_requests_status_check') THEN
        ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_status_check
            CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'FAILED', 'EXPIRED'));
    END IF;

    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(80);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS phone_hash VARCHAR(80);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS account_reference VARCHAR(12);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS response_code VARCHAR(40);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS result_code VARCHAR(20);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS error TEXT;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS customer_message TEXT;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS fallback_bound_at TIMESTAMPTZ;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stk_requests_agent_idempotency_key') THEN
        ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_agent_idempotency_key UNIQUE (agent_id, idempotency_key);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stk_requests_accepted_has_checkout') THEN
        ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_accepted_has_checkout
            CHECK (status <> 'ACCEPTED' OR checkout_request_id IS NOT NULL);
    END IF;
    CREATE INDEX IF NOT EXISTS stk_requests_fallback_idx ON stk_requests (phone_hash, amount, created_at);
    CREATE INDEX IF NOT EXISTS stk_requests_open_idx ON stk_requests (created_at) WHERE status IN ('PENDING', 'UNKNOWN');

    CREATE TABLE IF NOT EXISTS stk_failed_callbacks (
        checkout_request_id VARCHAR(100) PRIMARY KEY,
        result_code VARCHAR(20) NOT NULL,
        result_desc TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── security_events: subject-generic ────────────────────────────────────
    ALTER TABLE security_events ALTER COLUMN mpesa_receipt_id DROP NOT NULL;
    ALTER TABLE security_events ADD COLUMN IF NOT EXISTS subject_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
    ALTER TABLE security_events ADD COLUMN IF NOT EXISTS family_id UUID;
    ALTER TABLE security_events DROP CONSTRAINT IF EXISTS security_events_event_type_check;
    ALTER TABLE security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN (
        'PAYLOAD_MUTATION', 'STK_RECEIPT_REPLAY', 'STK_CHANNEL_ECHO',
        'REFRESH_TOKEN_REUSE', 'LOGIN_LOCKOUT', 'PIN_CHANGED',
        'ADMIN_UNLOCK', 'ADMIN_DISABLE', 'ADMIN_PIN_RESET'));
    CREATE UNIQUE INDEX IF NOT EXISTS security_events_family_dedup
        ON security_events (event_type, family_id) WHERE family_id IS NOT NULL;

    INSERT INTO schema_migrations (version) VALUES ('002_auth_stk_initiation');
END
$migration$;

COMMIT;
