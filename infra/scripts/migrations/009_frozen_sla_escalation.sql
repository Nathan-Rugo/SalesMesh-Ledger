-- Migration 009: frozen-payout SLA escalation (spec gh-11, part 3c).
--
-- Brings a database at migration 008 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001-008).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/009_frozen_sla_escalation.sql

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialise concurrent runs of this migration.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '009_frozen_sla_escalation') THEN
        RAISE NOTICE '009_frozen_sla_escalation already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '008_ufaa_remittance') THEN
        RAISE EXCEPTION 'migration 008_ufaa_remittance must be applied before 009_frozen_sla_escalation';
    END IF;

    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS sla_escalated_at TIMESTAMPTZ;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS unresolved_at TIMESTAMPTZ;
    ALTER TABLE payouts ADD COLUMN IF NOT EXISTS sla_escalated_at TIMESTAMPTZ;

    -- Backfill: a quarantine froze at its latest evaluation (else now); an UNRESOLVED payout at its last update.
    UPDATE escrow_accounts e
       SET frozen_at = COALESCE((SELECT max(v.evaluated_at) FROM verification_events v WHERE v.transaction_id = e.transaction_id), NOW())
     WHERE e.escrow_status = 'QUARANTINED' AND e.frozen_at IS NULL;
    UPDATE payouts SET unresolved_at = updated_at WHERE status = 'UNRESOLVED' AND unresolved_at IS NULL;

    CREATE OR REPLACE FUNCTION escrow_accounts_freeze_clock() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
        IF NEW.escrow_status = 'QUARANTINED' THEN
            IF TG_OP = 'INSERT' OR OLD.escrow_status IS DISTINCT FROM 'QUARANTINED' THEN
                NEW.frozen_at := NOW();
                NEW.sla_escalated_at := NULL;
            END IF;
        ELSE
            NEW.frozen_at := NULL;
            NEW.sla_escalated_at := NULL;
        END IF;
        RETURN NEW;
    END
    $fn$;
    DROP TRIGGER IF EXISTS escrow_accounts_freeze_clock ON escrow_accounts;
    CREATE TRIGGER escrow_accounts_freeze_clock BEFORE INSERT OR UPDATE OF escrow_status ON escrow_accounts
        FOR EACH ROW EXECUTE FUNCTION escrow_accounts_freeze_clock();

    CREATE INDEX IF NOT EXISTS escrow_accounts_frozen_idx ON escrow_accounts (frozen_at) WHERE escrow_status = 'QUARANTINED';
    CREATE INDEX IF NOT EXISTS payouts_unresolved_idx ON payouts (unresolved_at) WHERE status = 'UNRESOLVED';

    INSERT INTO schema_migrations (version) VALUES ('009_frozen_sla_escalation');
END
$migration$;

COMMIT;
