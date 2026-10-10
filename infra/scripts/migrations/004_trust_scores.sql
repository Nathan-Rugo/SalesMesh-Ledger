-- Migration 004: risk-adaptive escrow hold and trust scores (spec gh-23).
--
-- Brings a database at migration 003 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001-003);
-- column-type changes are additionally guarded by information_schema checks.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/004_trust_scores.sql
--
-- Every existing agent is reset to the new default rating 0.5 with no history credit, so nobody
-- jumps to a 1-hour hold on the strength of payments settled before trust existed. Escrows created
-- before this migration have NULL hold_seconds and never earn a maturity credit.
--
-- LOCKING: the type changes take ACCESS EXCLUSIVE locks on sales_agents and trust_scores until
-- COMMIT. Run it in a maintenance window with the gateway stopped.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialise concurrent runs of this migration.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $migration$
DECLARE
    v_dups TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004_trust_scores') THEN
        RAISE NOTICE '004_trust_scores already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003_reconciliation') THEN
        RAISE EXCEPTION 'migration 003_reconciliation must be applied before 004_trust_scores';
    END IF;

    -- ── sales_agents: outcome-based rating, default 0.5, scored count ───────
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sales_agents' AND column_name = 'agent_trust_rating'
                      AND numeric_precision = 7 AND numeric_scale = 6) THEN
        ALTER TABLE sales_agents ALTER COLUMN agent_trust_rating TYPE NUMERIC(7,6);
    END IF;
    ALTER TABLE sales_agents ALTER COLUMN agent_trust_rating SET DEFAULT 0.5;
    UPDATE sales_agents SET agent_trust_rating = 0.5;
    ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS scored_txn_count INTEGER NOT NULL DEFAULT 0;

    -- ── trust_config_snapshots ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS trust_config_snapshots (
        config_hash VARCHAR(64) PRIMARY KEY,
        params JSONB NOT NULL,
        formula_version VARCHAR(16) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── trust_scores (Table 7, extended) ────────────────────────────────────
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'trust_scores' AND column_name = 'final_trust_index'
                      AND numeric_precision = 7 AND numeric_scale = 6) THEN
        ALTER TABLE trust_scores ALTER COLUMN final_trust_index TYPE NUMERIC(7,6);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'trust_scores'::regclass AND conname = 'trust_scores_verification_id_key') THEN
        SELECT string_agg(verification_id::text, ', ') INTO v_dups
          FROM (SELECT verification_id FROM trust_scores GROUP BY 1 HAVING count(*) > 1) d;
        IF v_dups IS NOT NULL THEN
            RAISE EXCEPTION 'trust_scores has several rows per verification_id (%); keep one each, then re-run', v_dups;
        END IF;
        ALTER TABLE trust_scores ADD CONSTRAINT trust_scores_verification_id_key UNIQUE (verification_id);
    END IF;
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS transaction_trust NUMERIC(7,6);
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS p_used NUMERIC(7,6);
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS p_source VARCHAR(20) CHECK (p_source IN ('xgb', 'isolation_proxy'));
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS agent_rating_used NUMERIC(7,6);
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS amount_factor NUMERIC(14,6);
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS hold_seconds INTEGER;
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS hold_reason VARCHAR(12) CHECK (hold_reason IN ('transaction', 'agent', 'amount'));
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS config_hash VARCHAR(64)
        REFERENCES trust_config_snapshots(config_hash) ON DELETE RESTRICT;
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS formula_version VARCHAR(16);
    ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS trust_scores_created_idx ON trust_scores (created_at);

    -- ── agent_trust_events (agent FK ON DELETE RESTRICT on purpose: audit retention) ──
    CREATE TABLE IF NOT EXISTS agent_trust_events (
        trust_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
        cause VARCHAR(30) NOT NULL
            CHECK (cause IN ('HOLD_MATURED_CLEAN', 'STATEMENT_CONFIRMED', 'SECURITY_PENALTY', 'OPERATOR_ADJUST')),
        ref VARCHAR(200) NOT NULL,
        old_rating NUMERIC(7,6) NOT NULL,
        new_rating NUMERIC(7,6) NOT NULL,
        delta NUMERIC(8,6) NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT agent_trust_events_cause_ref_key UNIQUE (cause, ref)
    );
    CREATE INDEX IF NOT EXISTS agent_trust_events_agent_idx ON agent_trust_events (agent_id, cause, created_at);

    -- ── escrow_accounts: computed hold, quarantine reason ───────────────────
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS hold_seconds INTEGER;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS quarantine_reason VARCHAR(40);
    -- Backfill existing quarantines: security hold, else the latest verification's fail-safe flag.
    UPDATE escrow_accounts e
       SET quarantine_reason = CASE
             WHEN e.security_hold THEN 'security_hold'
             WHEN COALESCE((SELECT v.is_fail_safe FROM verification_events v
                             WHERE v.transaction_id = e.transaction_id
                             ORDER BY v.evaluated_at DESC, (v.kind = 'RESCORE') DESC, v.verification_id DESC
                             LIMIT 1), FALSE) THEN 'fail_safe'
             ELSE 'model_decision' END
     WHERE e.escrow_status = 'QUARANTINED' AND e.quarantine_reason IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'escrow_accounts'::regclass AND conname = 'escrow_accounts_quarantine_reason_check') THEN
        ALTER TABLE escrow_accounts ADD CONSTRAINT escrow_accounts_quarantine_reason_check CHECK (quarantine_reason IN (
            'security_hold', 'fail_safe', 'model_decision', 'trust_below_threshold', 'trust_input_invalid')) NOT VALID;
        ALTER TABLE escrow_accounts VALIDATE CONSTRAINT escrow_accounts_quarantine_reason_check;
    END IF;
    CREATE INDEX IF NOT EXISTS escrow_accounts_matured_idx
        ON escrow_accounts (release_due_at) WHERE escrow_status IN ('HELD', 'RELEASED') AND hold_seconds IS NOT NULL;

    INSERT INTO schema_migrations (version) VALUES ('004_trust_scores');
END
$migration$;

COMMIT;
