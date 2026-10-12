-- Migration 007: unclaimed payout reminders at 7, 30 and 90 days (spec gh-11, part 3a).
--
-- Brings a database at migration 006 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001-006).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/007_unclaimed_reminders.sql

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialise concurrent runs of this migration.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '007_unclaimed_reminders') THEN
        RAISE NOTICE '007_unclaimed_reminders already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '006_payout_claims') THEN
        RAISE EXCEPTION 'migration 006_payout_claims must be applied before 007_unclaimed_reminders';
    END IF;

    -- The highest reminder stage sent for the unclaimed cycle this (oldest claimable) escrow keys.
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS unclaimed_reminder_stage SMALLINT NOT NULL DEFAULT 0
        CONSTRAINT escrow_accounts_unclaimed_reminder_stage CHECK (unclaimed_reminder_stage BETWEEN 0 AND 3);
    CREATE INDEX IF NOT EXISTS escrow_accounts_claimable_idx
        ON escrow_accounts (release_due_at) WHERE escrow_status = 'HELD' AND NOT security_hold;

    INSERT INTO schema_migrations (version) VALUES ('007_unclaimed_reminders');
END
$migration$;

COMMIT;
