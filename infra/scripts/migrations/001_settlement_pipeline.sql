-- Migration 001: settlement pipeline (spec gh-6).
--
-- Brings a database created by the original init_db.sql to the shape of the current
-- init_db.sql. Idempotent: the whole migration is one transaction behind a schema_migrations
-- guard, and every step is additionally written to be a no-op when already applied.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/001_settlement_pipeline.sql
--
-- Legacy TIMESTAMP columns (transactions.timestamp, escrow_accounts.release_due_at) carry no
-- zone; they are interpreted as UTC unless you say otherwise for the session, e.g.:
--
--   PGOPTIONS="-c salesmesh.legacy_tz=Africa/Nairobi" psql ... -f 001_settlement_pipeline.sql
--   (or run `SET salesmesh.legacy_tz = 'Africa/Nairobi';` first in the same psql session)
--
-- Legacy duplicate escrows (several rows per transaction) abort the migration with a list of
-- the affected transaction_ids; resolve them (keep one escrow per transaction) and re-run.

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
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001_settlement_pipeline') THEN
        RAISE NOTICE '001_settlement_pipeline already applied; skipping';
        RETURN;
    END IF;

    -- ── sales_agents.agent_code ─────────────────────────────────────────────
    ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS agent_code VARCHAR(32);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_agents_agent_code_normalised') THEN
        ALTER TABLE sales_agents ADD CONSTRAINT sales_agents_agent_code_normalised
            CHECK (agent_code = UPPER(BTRIM(agent_code)) AND agent_code <> '');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = 'sales_agents'::regclass AND i.indisunique AND i.indnkeyatts = 1
          AND a.attname = 'agent_code' AND i.indpred IS NULL
    ) THEN
        ALTER TABLE sales_agents ADD CONSTRAINT sales_agents_agent_code_key UNIQUE (agent_code);
    END IF;

    -- ── new tables ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS mpesa_callbacks (
        callback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mpesa_receipt_id VARCHAR(50) UNIQUE NOT NULL,
        raw_payload_hash VARCHAR(80) NOT NULL,
        source_channel VARCHAR(30) NOT NULL CHECK (source_channel IN ('DARAJA_STK', 'C2B')),
        payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING', 'PROCESSING', 'UNRESOLVED', 'SETTLED', 'FAILED', 'DEAD')),
        attempts INTEGER NOT NULL DEFAULT 0,
        resolve_attempts INTEGER NOT NULL DEFAULT 0,
        resolve_deadline TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        claim_token UUID,
        last_error TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        transaction_id UUID
    );
    CREATE INDEX IF NOT EXISTS mpesa_callbacks_ready_idx
        ON mpesa_callbacks (next_attempt_at, received_at) WHERE status IN ('PENDING', 'UNRESOLVED');
    CREATE INDEX IF NOT EXISTS mpesa_callbacks_processing_idx
        ON mpesa_callbacks (claimed_at) WHERE status = 'PROCESSING';
    CREATE INDEX IF NOT EXISTS mpesa_callbacks_open_idx
        ON mpesa_callbacks (status, received_at) WHERE status <> 'SETTLED';

    CREATE TABLE IF NOT EXISTS stk_requests (
        checkout_request_id VARCHAR(100) PRIMARY KEY,
        merchant_request_id VARCHAR(100),
        agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
        amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
        consumed_receipt VARCHAR(50) UNIQUE,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_events (
        event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type VARCHAR(40) NOT NULL CHECK (event_type IN ('PAYLOAD_MUTATION', 'STK_RECEIPT_REPLAY')),
        mpesa_receipt_id VARCHAR(50) NOT NULL,
        original_hash VARCHAR(80),
        incoming_hash VARCHAR(80) NOT NULL DEFAULT '',
        detail TEXT,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_events_dedup UNIQUE (event_type, mpesa_receipt_id, incoming_hash)
    );

    -- ── transactions ────────────────────────────────────────────────────────
    ALTER TABLE transactions ALTER COLUMN raw_payload_hash TYPE VARCHAR(80);
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'transactions' AND column_name = 'timestamp')
       = 'timestamp without time zone' THEN
        ALTER TABLE transactions ALTER COLUMN timestamp TYPE TIMESTAMPTZ
            USING timestamp AT TIME ZONE COALESCE(NULLIF(current_setting('salesmesh.legacy_tz', true), ''), 'UTC');
    END IF;

    -- Backfill first, then constrain.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counterparty_hash VARCHAR(100);
    UPDATE transactions SET counterparty_hash = 'legacy:' || mpesa_receipt_id WHERE counterparty_hash IS NULL;
    ALTER TABLE transactions ALTER COLUMN counterparty_hash SET NOT NULL;

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS callback_id UUID;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_callback_id_fkey') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_callback_id_fkey
            FOREIGN KEY (callback_id) REFERENCES mpesa_callbacks(callback_id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'transactions' AND column_name = 'ingested_at') THEN
        ALTER TABLE transactions ADD COLUMN ingested_at TIMESTAMPTZ;
        UPDATE transactions SET ingested_at = timestamp;
        ALTER TABLE transactions ALTER COLUMN ingested_at SET DEFAULT NOW();
        ALTER TABLE transactions ALTER COLUMN ingested_at SET NOT NULL;
    END IF;

    CREATE INDEX IF NOT EXISTS transactions_agent_time_idx ON transactions (agent_id, timestamp);

    -- ── verification_events: append-only audit history ──────────────────────
    -- Drop the old UNIQUE(transaction_id), whatever it was named.
    FOR v_name IN
        SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid = 'verification_events'::regclass AND c.contype = 'u'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = 'verification_events'::regclass AND attname = 'transaction_id')]::smallint[]
    LOOP
        EXECUTE format('ALTER TABLE verification_events DROP CONSTRAINT %I', v_name);
    END LOOP;

    ALTER TABLE verification_events ALTER COLUMN isolation_forest_score TYPE DOUBLE PRECISION;
    ALTER TABLE verification_events ALTER COLUMN xgboost_fraud_prob TYPE DOUBLE PRECISION;
    ALTER TABLE verification_events ALTER COLUMN isolation_forest_score DROP NOT NULL;
    ALTER TABLE verification_events ALTER COLUMN xgboost_fraud_prob DROP NOT NULL;
    ALTER TABLE verification_events ALTER COLUMN model_version TYPE VARCHAR(64);

    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS decision VARCHAR(12);
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS layer2_adjudicated BOOLEAN;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS model_sha256 VARCHAR(64);
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS triggered_layer SMALLINT;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS is_fail_safe BOOLEAN;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS fail_safe_cause VARCHAR(40);
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS history_truncated BOOLEAN;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS reason TEXT;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS kind VARCHAR(10);
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS history_receipts TEXT[];

    -- Backfill legacy rows (fail closed: unknown decisions are QUARANTINE).
    UPDATE verification_events
       SET is_fail_safe = (model_version LIKE '%-failsafe' OR isolation_forest_score < 0 OR xgboost_fraud_prob < 0)
     WHERE is_fail_safe IS NULL;
    UPDATE verification_events SET isolation_forest_score = NULL WHERE isolation_forest_score < 0;
    UPDATE verification_events SET xgboost_fraud_prob = NULL WHERE xgboost_fraud_prob < 0;
    UPDATE verification_events SET decision = 'QUARANTINE' WHERE decision IS NULL;
    UPDATE verification_events SET kind = 'INITIAL' WHERE kind IS NULL;
    UPDATE verification_events SET history_truncated = FALSE WHERE history_truncated IS NULL;
    UPDATE verification_events v SET evaluated_at = COALESCE(
        (SELECT t.ingested_at FROM transactions t WHERE t.transaction_id = v.transaction_id), NOW())
     WHERE evaluated_at IS NULL;
    UPDATE verification_events SET fail_safe_cause = 'legacy' WHERE is_fail_safe AND fail_safe_cause IS NULL;

    ALTER TABLE verification_events ALTER COLUMN decision SET NOT NULL;
    ALTER TABLE verification_events ALTER COLUMN is_fail_safe SET DEFAULT FALSE;
    ALTER TABLE verification_events ALTER COLUMN is_fail_safe SET NOT NULL;
    ALTER TABLE verification_events ALTER COLUMN history_truncated SET DEFAULT FALSE;
    ALTER TABLE verification_events ALTER COLUMN history_truncated SET NOT NULL;
    ALTER TABLE verification_events ALTER COLUMN kind SET DEFAULT 'INITIAL';
    ALTER TABLE verification_events ALTER COLUMN kind SET NOT NULL;
    ALTER TABLE verification_events ALTER COLUMN evaluated_at SET DEFAULT NOW();
    ALTER TABLE verification_events ALTER COLUMN evaluated_at SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_events_decision_check') THEN
        ALTER TABLE verification_events ADD CONSTRAINT verification_events_decision_check
            CHECK (decision IN ('CLEAR', 'QUARANTINE', 'REVIEW'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_events_kind_check') THEN
        ALTER TABLE verification_events ADD CONSTRAINT verification_events_kind_check
            CHECK (kind IN ('INITIAL', 'RESCORE'));
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS verification_events_initial_uq
        ON verification_events (transaction_id) WHERE kind = 'INITIAL';
    CREATE INDEX IF NOT EXISTS verification_events_latest_idx
        ON verification_events (transaction_id, evaluated_at DESC);

    -- ── escrow_accounts ─────────────────────────────────────────────────────
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'escrow_accounts' AND column_name = 'release_due_at')
       = 'timestamp without time zone' THEN
        ALTER TABLE escrow_accounts ALTER COLUMN release_due_at TYPE TIMESTAMPTZ
            USING release_due_at AT TIME ZONE COALESCE(NULLIF(current_setting('salesmesh.legacy_tz', true), ''), 'UTC');
    END IF;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS security_hold BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS rescore_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS next_rescore_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS rescore_claimed_at TIMESTAMPTZ;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS rescore_claim_token UUID;
    -- The original schema had no UNIQUE(transaction_id); settlement relies on it for ON CONFLICT.
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = 'escrow_accounts'::regclass AND i.indisunique AND i.indnkeyatts = 1
          AND a.attname = 'transaction_id' AND i.indpred IS NULL
    ) THEN
        SELECT string_agg(transaction_id::text, ', ') INTO v_name FROM (
            SELECT transaction_id FROM escrow_accounts GROUP BY transaction_id HAVING count(*) > 1
             ORDER BY transaction_id LIMIT 10) d;
        IF v_name IS NOT NULL THEN
            RAISE EXCEPTION 'escrow_accounts has duplicate escrows per transaction (first 10: %)', v_name
                USING HINT = 'Keep exactly one escrow per transaction_id (review which one is authoritative), then re-run this migration.';
        END IF;
        ALTER TABLE escrow_accounts ADD CONSTRAINT escrow_accounts_transaction_id_key UNIQUE (transaction_id);
    END IF;
    CREATE INDEX IF NOT EXISTS escrow_accounts_rescore_idx
        ON escrow_accounts (next_rescore_at) WHERE escrow_status = 'QUARANTINED' AND NOT security_hold;

    INSERT INTO schema_migrations (version) VALUES ('001_settlement_pipeline');
END
$migration$;

-- Also for databases that ran an earlier build of this migration (idempotent).
ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS history_receipts TEXT[];

COMMIT;
