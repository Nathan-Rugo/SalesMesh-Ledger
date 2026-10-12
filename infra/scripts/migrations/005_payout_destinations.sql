-- Migration 005: verified payout destinations (spec gh-11, part 1).
--
-- Brings a database at migration 004 to the shape of the current init_db.sql. Idempotent: the
-- whole migration is one transaction behind a schema_migrations guard (same pattern as 001-004).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/scripts/migrations/005_payout_destinations.sql
--
-- Drops the unused `wallets` placeholder (nothing references it; refused if it holds rows).

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
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005_payout_destinations') THEN
        RAISE NOTICE '005_payout_destinations already applied; skipping';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '004_trust_scores') THEN
        RAISE EXCEPTION 'migration 004_trust_scores must be applied before 005_payout_destinations';
    END IF;

    -- ── payout_destinations ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS payout_destinations (
        destination_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- also the B2C OriginatorConversationID
        agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
        msisdn VARCHAR(12) NOT NULL CHECK (msisdn ~ '^254[17][0-9]{8}$'),
        status VARCHAR(25) NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN (
            'PENDING_VERIFICATION', 'COOLING_OFF', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
        reject_reason VARCHAR(40),
        conversation_id VARCHAR(100),
        result_code VARCHAR(20),
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_at TIMESTAMPTZ,
        cooling_off_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT payout_destinations_cooling_off_until CHECK (status <> 'COOLING_OFF' OR cooling_off_until IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS payout_destinations_one_active
        ON payout_destinations (agent_id) WHERE status = 'ACTIVE';
    CREATE UNIQUE INDEX IF NOT EXISTS payout_destinations_one_in_flight
        ON payout_destinations (agent_id) WHERE status IN ('PENDING_VERIFICATION', 'COOLING_OFF');

    -- ── wallets: unused placeholder ─────────────────────────────────────────
    IF to_regclass('public.wallets') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM wallets) THEN
            RAISE EXCEPTION 'wallets holds rows; it is no longer used: move or delete them, then re-run';
        END IF;
        DROP TABLE wallets;
    END IF;

    -- ── security_events: PAYOUT_DESTINATION_CHANGED ─────────────────────────
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
        'PAYOUT_DESTINATION_CHANGED')) NOT VALID;
    ALTER TABLE security_events VALIDATE CONSTRAINT security_events_event_type_check;
    -- The agent's in-app list of recent payout-destination events.
    CREATE INDEX IF NOT EXISTS security_events_payout_destination_idx
        ON security_events (subject_user_id, detected_at) WHERE event_type = 'PAYOUT_DESTINATION_CHANGED';

    INSERT INTO schema_migrations (version) VALUES ('005_payout_destinations');
END
$migration$;

COMMIT;
