-- Migration 010: merchant admin risk-oversight queue (spec gh-14).
--
-- Brings a database at migration 009 to the shape of the current init_db.sql. Additive only (no data
-- rewrite): SHAP attributions on verification_events (recorded from now on; older events stay NULL),
-- escrow_accounts.reviewed_at ("Keep held", cleared with the freeze spell) and the ESCROW_OVERRIDE
-- audit event. Idempotent: one transaction behind a schema_migrations guard (same pattern as 001-009).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/010_admin_oversight.sql

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
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '010_admin_oversight') THEN
        RAISE NOTICE '010_admin_oversight already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '009_frozen_sla_escalation') THEN
        RAISE EXCEPTION 'migration 009_frozen_sla_escalation must be applied before 010_admin_oversight';
    END IF;

    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS shap_features JSONB;
    ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS shap_units VARCHAR(64);
    ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

    -- The freeze clock also clears the admin review when a spell starts or ends.
    CREATE OR REPLACE FUNCTION escrow_accounts_freeze_clock() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
        IF NEW.escrow_status = 'QUARANTINED' THEN
            IF TG_OP = 'INSERT' OR OLD.escrow_status IS DISTINCT FROM 'QUARANTINED' THEN
                NEW.frozen_at := NOW();
                NEW.sla_escalated_at := NULL;
                NEW.reviewed_at := NULL;
            END IF;
        ELSE
            NEW.frozen_at := NULL;
            NEW.sla_escalated_at := NULL;
            NEW.reviewed_at := NULL;
        END IF;
        RETURN NEW;
    END
    $fn$;

    -- ── security_events: ESCROW_OVERRIDE ────────────────────────────────────
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
        'PAYOUT_DESTINATION_CHANGED', 'PAYOUT_STATUS_CHANGED', 'PAYOUT_NAME_MISMATCH',
        'UFAA_NOTICE_SENT', 'UFAA_REPORTED', 'UFAA_REMITTED',
        'ESCROW_OVERRIDE')) NOT VALID;
    ALTER TABLE security_events VALIDATE CONSTRAINT security_events_event_type_check;

    INSERT INTO schema_migrations (version) VALUES ('010_admin_oversight');
END
$migration$;

COMMIT;
