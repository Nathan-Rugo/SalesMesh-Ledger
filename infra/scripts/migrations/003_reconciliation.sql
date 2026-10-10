-- Migration 003: Daraja reconciliation — STK Query sweeps and M-Pesa statement import (spec gh-6-recon).
--
-- Brings a database at migration 002 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001/002).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/003_reconciliation.sql
--
-- CHECK constraints that earlier installs created with auto-generated names (the stk_requests
-- status list, the security_events type list) are looked up in pg_constraint by what they check,
-- dropped (IF EXISTS), and re-added NOT VALID + VALIDATE. Existing callback rows get their
-- CheckoutRequestID copied out of the JSONB payload once, so the sweep never scans JSONB.
--
-- LOCKING: everything runs in ONE transaction. The column type change and the constraint changes
-- take ACCESS EXCLUSIVE locks on stk_requests, mpesa_callbacks and security_events that are held
-- until COMMIT, through the full backfill and the VALIDATEs (NOT VALID + VALIDATE does not shorten
-- that here). Run it in a maintenance window with the gateway stopped.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialise concurrent runs of this migration.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $migration$
DECLARE
    v_con RECORD;
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003_reconciliation') THEN
        RAISE NOTICE '003_reconciliation already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002_auth_stk_initiation') THEN
        RAISE EXCEPTION 'migration 002_auth_stk_initiation must be applied before 003_reconciliation';
    END IF;

    -- ── reconciliation_runs ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS reconciliation_runs (
        run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_sha256 VARCHAR(64) NOT NULL,
        file_name VARCHAR(255),
        operator_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(12) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        short_code VARCHAR(20),
        account VARCHAR(100),
        period_start TIMESTAMPTZ,
        period_end TIMESTAMPTZ,
        rows_total INTEGER NOT NULL DEFAULT 0,
        rows_new INTEGER NOT NULL DEFAULT 0,
        counts JSONB NOT NULL DEFAULT '{}'::jsonb,
        noop_of_run_id UUID,
        evidence_path TEXT,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS reconciliation_runs_sha_idx ON reconciliation_runs (file_sha256, status);

    -- ── mpesa_callbacks: provenance, indexed CheckoutRequestID, late confirmation ─
    ALTER TABLE mpesa_callbacks ADD COLUMN IF NOT EXISTS origin VARCHAR(12) NOT NULL DEFAULT 'CALLBACK'
        CHECK (origin IN ('CALLBACK', 'RECONCILED'));
    ALTER TABLE mpesa_callbacks ADD COLUMN IF NOT EXISTS reconciliation_run_id UUID
        REFERENCES reconciliation_runs(run_id) ON DELETE RESTRICT;
    ALTER TABLE mpesa_callbacks ADD COLUMN IF NOT EXISTS checkout_request_id VARCHAR(100);
    ALTER TABLE mpesa_callbacks ADD COLUMN IF NOT EXISTS stk_request_id UUID;
    ALTER TABLE mpesa_callbacks ADD COLUMN IF NOT EXISTS confirmed_by_callback_at TIMESTAMPTZ;
    ALTER TABLE mpesa_callbacks ADD COLUMN IF NOT EXISTS confirmed_hash VARCHAR(80);
    UPDATE mpesa_callbacks
       SET checkout_request_id = LEFT(NULLIF(BTRIM(payload->'Body'->'stkCallback'->>'CheckoutRequestID'), ''), 100)
     WHERE source_channel = 'DARAJA_STK' AND checkout_request_id IS NULL;
    CREATE INDEX IF NOT EXISTS mpesa_callbacks_checkout_idx
        ON mpesa_callbacks (checkout_request_id) WHERE checkout_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS mpesa_callbacks_stk_request_idx
        ON mpesa_callbacks (stk_request_id) WHERE stk_request_id IS NOT NULL;

    -- ── stk_requests: new statuses, sweep lease, masked-phone fingerprint ───
    FOR v_con IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'stk_requests'::regclass AND contype = 'c'
           AND (conname = 'stk_requests_accepted_has_checkout'
                OR (pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%''PENDING''%'))
    LOOP
        EXECUTE format('ALTER TABLE stk_requests DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;
    ALTER TABLE stk_requests ALTER COLUMN status TYPE VARCHAR(20);
    -- The type change rewrites the partial index predicate; rebuild it in its fresh-install form.
    DROP INDEX IF EXISTS stk_requests_open_idx;
    CREATE INDEX stk_requests_open_idx ON stk_requests (created_at) WHERE status IN ('PENDING', 'UNKNOWN');
    ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_status_check
        CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'FAILED',
                          'EXPIRED', 'PAID_UNCONFIRMED', 'RECONCILE_EXHAUSTED')) NOT VALID;
    ALTER TABLE stk_requests VALIDATE CONSTRAINT stk_requests_status_check;
    ALTER TABLE stk_requests ADD CONSTRAINT stk_requests_accepted_has_checkout
        CHECK (status NOT IN ('ACCEPTED', 'PAID_UNCONFIRMED') OR checkout_request_id IS NOT NULL) NOT VALID;
    ALTER TABLE stk_requests VALIDATE CONSTRAINT stk_requests_accepted_has_checkout;

    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS phone_mask_hash VARCHAR(80);
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS reconcile_claimed_at TIMESTAMPTZ;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS reconcile_claim_token UUID;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS last_query_result TEXT;
    ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS last_queried_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS stk_requests_reconcile_idx
        ON stk_requests (created_at) WHERE status = 'ACCEPTED' AND consumed_receipt IS NULL;
    CREATE INDEX IF NOT EXISTS stk_requests_bind_idx
        ON stk_requests (agent_id, amount, created_at) WHERE consumed_receipt IS NULL;

    -- ── security_events: reconciliation types, STK-request subject ──────────
    FOR v_con IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'security_events'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%event_type%'
    LOOP
        EXECUTE format('ALTER TABLE security_events DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;
    ALTER TABLE security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN (
        'PAYLOAD_MUTATION', 'STK_RECEIPT_REPLAY', 'STK_CHANNEL_ECHO',
        'REFRESH_TOKEN_REUSE', 'LOGIN_LOCKOUT', 'PIN_CHANGED',
        'ADMIN_UNLOCK', 'ADMIN_DISABLE', 'ADMIN_PIN_RESET',
        'RECONCILE_AMOUNT_MISMATCH', 'PAYMENT_REVERSED', 'RECONCILED_CALLBACK_LATE',
        'RECONCILE_ATTRIBUTION_CONFLICT', 'RECONCILE_NOT_ON_STATEMENT', 'STK_STATUS_CONFLICT')) NOT VALID;
    ALTER TABLE security_events VALIDATE CONSTRAINT security_events_event_type_check;
    ALTER TABLE security_events ADD COLUMN IF NOT EXISTS stk_request_id UUID;
    CREATE UNIQUE INDEX IF NOT EXISTS security_events_stk_dedup
        ON security_events (event_type, stk_request_id) WHERE stk_request_id IS NOT NULL;

    -- ── transactions: two-way reconciliation by payment time ────────────────
    CREATE INDEX IF NOT EXISTS transactions_time_idx ON transactions (timestamp);

    -- ── reconciliation_exceptions ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
        exception_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(30) NOT NULL CHECK (kind IN ('CLAWBACK_DUE', 'RELEASED_NOT_ON_STATEMENT')),
        mpesa_receipt_id VARCHAR(50) NOT NULL,
        related_receipt_id VARCHAR(50) NOT NULL DEFAULT '',
        run_id UUID REFERENCES reconciliation_runs(run_id) ON DELETE RESTRICT,
        escrow_id UUID REFERENCES escrow_accounts(escrow_id) ON DELETE RESTRICT,
        amount DECIMAL(12,2),
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        CONSTRAINT reconciliation_exceptions_dedup UNIQUE (kind, mpesa_receipt_id, related_receipt_id)
    );

    INSERT INTO schema_migrations (version) VALUES ('003_reconciliation');
END
$migration$;

COMMIT;
