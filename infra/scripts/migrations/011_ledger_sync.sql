-- Migration 011: Fabric ledger synchronisation (DLT-03, #10).
--
-- Brings a database at migration 010 to the shape of the current init_db.sql. Additive only: the
-- ledger_outbox (every escrow / payout write the gateway owes the commission chaincode), the committed
-- tx id / block number / block hash on escrows and payouts, and the auditor_hold quarantine reason
-- (an escrow the auditor holds on the ledger). Existing escrows get no outbox row here: the HMAC key
-- is not in the database, so `npm run ledger:init` backfills them. Idempotent: one transaction behind a
-- schema_migrations guard (same pattern as 001-010).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/011_ledger_sync.sql

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialise concurrent runs of this migration.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '011_ledger_sync') THEN
        RAISE NOTICE '011_ledger_sync already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '010_admin_oversight') THEN
        RAISE EXCEPTION 'migration 010_admin_oversight must be applied before 011_ledger_sync';
    END IF;

    ALTER TABLE escrow_accounts DROP CONSTRAINT IF EXISTS escrow_accounts_quarantine_reason_check;
    ALTER TABLE escrow_accounts ADD CONSTRAINT escrow_accounts_quarantine_reason_check CHECK (quarantine_reason IN (
        'security_hold', 'fail_safe', 'model_decision', 'trust_below_threshold', 'trust_input_invalid', 'auditor_hold'));
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS ledger_tx_id VARCHAR(64);
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS ledger_block_number BIGINT;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS ledger_block_hash VARCHAR(64);
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS ledger_state_hash VARCHAR(64);
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS ledger_state_key_id VARCHAR(8);

    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS ledger_tx_id VARCHAR(64);
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS ledger_block_number BIGINT;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS ledger_block_hash VARCHAR(64);
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS ledger_authorise_tx_ids TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS ledger_consent_digest VARCHAR(64);
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS ledger_consent_key_id VARCHAR(8);

    CREATE TABLE IF NOT EXISTS ledger_outbox (
        outbox_id BIGSERIAL PRIMARY KEY,
        op VARCHAR(12) NOT NULL CHECK (op IN ('COMMIT', 'QUARANTINE', 'RELEASE', 'SETTLE')),
        keys TEXT[] NOT NULL CHECK (cardinality(keys) > 0),
        request TEXT NOT NULL,
        request_id UUID,
        escrow_id UUID REFERENCES escrow_accounts(escrow_id) ON DELETE RESTRICT,
        payout_id UUID REFERENCES payouts(payout_id) ON DELETE RESTRICT,
        absent_tx_ids TEXT[],
        status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD', 'SUPERSEDED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        claim_token UUID,
        last_error TEXT,
        tx_id VARCHAR(64),
        block_number BIGINT,
        block_hash VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ledger_outbox_open_idx ON ledger_outbox (status, outbox_id) WHERE status IN ('PENDING', 'DEAD');
    CREATE INDEX IF NOT EXISTS ledger_outbox_open_keys_idx ON ledger_outbox USING GIN (keys) WHERE status IN ('PENDING', 'DEAD');
    CREATE INDEX IF NOT EXISTS ledger_outbox_escrow_idx ON ledger_outbox (escrow_id) WHERE escrow_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ledger_outbox_hash_idx ON ledger_outbox (block_number) WHERE block_number IS NOT NULL AND block_hash IS NULL;
    CREATE INDEX IF NOT EXISTS payouts_ledger_hash_idx ON payouts (ledger_block_number) WHERE ledger_block_number IS NOT NULL AND ledger_block_hash IS NULL;
    CREATE INDEX IF NOT EXISTS escrow_accounts_auditor_hold_idx ON escrow_accounts (escrow_id) WHERE quarantine_reason = 'auditor_hold';

    INSERT INTO schema_migrations (version) VALUES ('011_ledger_sync');
END
$migration$;

COMMIT;
