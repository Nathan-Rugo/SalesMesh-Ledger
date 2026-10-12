-- Migration 006: agent-claimed commission payouts (spec gh-11, part 2).
--
-- Brings a database at migration 005 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001-005).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/006_payout_claims.sql
--
-- Drops the unused per-escrow `payout_disbursements` placeholder (refused if it holds rows).

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
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '006_payout_claims') THEN
        RAISE NOTICE '006_payout_claims already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005_payout_destinations') THEN
        RAISE EXCEPTION 'migration 005_payout_destinations must be applied before 006_payout_claims';
    END IF;

    -- ── payout_disbursements: unused placeholder ────────────────────────────
    IF to_regclass('public.payout_disbursements') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM payout_disbursements) THEN
            RAISE EXCEPTION 'payout_disbursements holds rows; it is no longer used: move or delete them, then re-run';
        END IF;
        DROP TABLE payout_disbursements;
    END IF;

    -- ── sales_agents: the shilling-rounding remainder carried to the next claim ──
    ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS payout_carry_cents INTEGER NOT NULL DEFAULT 0
        CONSTRAINT sales_agents_payout_carry_cents CHECK (payout_carry_cents BETWEEN 0 AND 99);

    -- ── payouts ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS payouts (
        payout_id UUID PRIMARY KEY,                       -- also the B2C OriginatorConversationID
        agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
        destination_id UUID NOT NULL REFERENCES payout_destinations(destination_id) ON DELETE RESTRICT,
        msisdn VARCHAR(12) NOT NULL CHECK (msisdn ~ '^254[17][0-9]{8}$'),
        amount INTEGER NOT NULL CHECK (amount > 0),        -- whole shillings sent
        gross_cents BIGINT NOT NULL CHECK (gross_cents > 0),
        carry_in_cents INTEGER NOT NULL CHECK (carry_in_cents BETWEEN 0 AND 99),
        carry_out_cents INTEGER NOT NULL CHECK (carry_out_cents BETWEEN 0 AND 99),
        status VARCHAR(12) NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'UNKNOWN', 'PAID', 'FAILED', 'UNRESOLVED')),
        failure_reason VARCHAR(40),
        disclosure_version VARCHAR(20) NOT NULL,
        consent_hash VARCHAR(64) NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL,
        conversation_id VARCHAR(100),
        receipt VARCHAR(50) UNIQUE,
        result_code VARCHAR(20),
        status_query_ids UUID[] NOT NULL DEFAULT '{}', -- every Transaction Status query's OriginatorConversationID (late answers still match)
        status_attempts INTEGER NOT NULL DEFAULT 0,
        next_status_at TIMESTAMPTZ,
        status_claimed_at TIMESTAMPTZ,
        status_claim_token UUID,
        last_status_result TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        CONSTRAINT payouts_carry_arithmetic CHECK (gross_cents + carry_in_cents = amount::bigint * 100 + carry_out_cents)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS payouts_one_open ON payouts (agent_id) WHERE status IN ('SENT', 'UNKNOWN', 'UNRESOLVED');
    CREATE INDEX IF NOT EXISTS payouts_agent_idx ON payouts (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS payouts_status_check_idx ON payouts (created_at) WHERE status IN ('SENT', 'UNKNOWN');
    CREATE INDEX IF NOT EXISTS payouts_status_query_ids_idx ON payouts USING GIN (status_query_ids);

    -- ── escrow_accounts: CLAIMED (paid out by a payout still in flight) ─────
    FOR v_con IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'escrow_accounts'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%escrow_status%'
    LOOP
        EXECUTE format('ALTER TABLE escrow_accounts DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS payout_id UUID REFERENCES payouts(payout_id) ON DELETE RESTRICT;
    ALTER TABLE escrow_accounts ADD CONSTRAINT escrow_accounts_escrow_status_check
        CHECK (escrow_status IN ('HELD', 'CLAIMED', 'QUARANTINED', 'RELEASED'));
    ALTER TABLE escrow_accounts ADD CONSTRAINT escrow_accounts_claimed_payout
        CHECK (escrow_status <> 'CLAIMED' OR payout_id IS NOT NULL);
    CREATE INDEX IF NOT EXISTS escrow_accounts_payout_idx ON escrow_accounts (payout_id) WHERE payout_id IS NOT NULL;
    DROP INDEX IF EXISTS escrow_accounts_matured_idx;
    CREATE INDEX escrow_accounts_matured_idx
        ON escrow_accounts (release_due_at) WHERE escrow_status IN ('HELD', 'CLAIMED', 'RELEASED') AND hold_seconds IS NOT NULL;

    -- ── security_events: PAYOUT_STATUS_CHANGED, PAYOUT_NAME_MISMATCH ───────
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
        'RECONCILE_ATTRIBUTION_CONFLICT', 'RECONCILE_NOT_ON_STATEMENT', 'STK_STATUS_CONFLICT',
        'PAYOUT_DESTINATION_CHANGED', 'PAYOUT_STATUS_CHANGED', 'PAYOUT_NAME_MISMATCH')) NOT VALID;
    ALTER TABLE security_events VALIDATE CONSTRAINT security_events_event_type_check;

    INSERT INTO schema_migrations (version) VALUES ('006_payout_claims');
END
$migration$;

COMMIT;
