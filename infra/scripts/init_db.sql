-- SalesMesh Physical Database DDL Schema (fresh install)
-- Aligned with Chapter 4 Data Dictionary (Tables 4.6 - 4.17), plus the settlement-pipeline
-- tables (mpesa_callbacks, stk_requests, security_events) from spec gh-6, the auth / STK
-- initiation tables (user_credentials, refresh_tokens, auth_events) from spec gh-5, and the Daraja
-- reconciliation tables (reconciliation_runs, reconciliation_exceptions) from spec gh-6-recon, and
-- the trust tables (trust_config_snapshots, agent_trust_events, extended trust_scores) from spec gh-23,
-- and payout destinations / agent-claimed payouts (payout_destinations, payouts) from spec gh-11.
--
-- Existing databases are brought to this shape by infra/scripts/migrations/*.sql; a fresh
-- install records those migrations as already applied (see schema_migrations at the end).
-- All timestamp columns touched by the settlement pipeline are TIMESTAMPTZ; sessions run in UTC.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Migration bookkeeping
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table 1: USERS
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('MERCHANT_ADMIN', 'SALES_AGENT')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    disabled_at TIMESTAMPTZ                          -- disabled users get 401 at login and refresh
);
-- phone_number is normalised (2547XXXXXXXX / 2541XXXXXXXX) by the user:create CLI and at login.

-- PIN credentials (spec gh-5): scrypt, per-user salt, versioned parameters.
CREATE TABLE IF NOT EXISTS user_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    algorithm VARCHAR(20) NOT NULL CHECK (algorithm IN ('scrypt')),
    params JSONB NOT NULL,                           -- {"v":1,"logN":15,"r":8,"p":1,"keylen":32}
    salt BYTEA NOT NULL,
    hash BYTEA NOT NULL,
    must_change BOOLEAN NOT NULL DEFAULT TRUE,       -- one-time PIN: only POST /api/v1/auth/pin is allowed
    one_time_expires_at TIMESTAMPTZ,                 -- a one-time PIN expires (72 h)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rotating refresh tokens (opaque; only their SHA-256 is stored). Reuse of a rotated token
-- revokes the whole family (theft detection).
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    family_id UUID NOT NULL,
    token_hash VARCHAR(80) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    family_expires_at TIMESTAMPTZ NOT NULL,          -- absolute end of the family (REFRESH_FAMILY_MAX_DAYS)
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
-- Retention purge (worker housekeeping): expired / revoked tokens older than 30 days.
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS refresh_tokens_revoked_idx ON refresh_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

-- Authentication audit trail (never PINs, tokens or raw user agents).
CREATE TABLE IF NOT EXISTS auth_events (
    auth_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(30) NOT NULL CHECK (event_type IN (
        'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED', 'REFRESH', 'REFRESH_FAILURE',
        'LOGOUT', 'PIN_CHANGED', 'PIN_CHANGE_FAILURE')),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    phone_hash VARCHAR(80),                          -- keyed HMAC of the normalised phone
    ip VARCHAR(64),
    user_agent_hash VARCHAR(80),
    reason VARCHAR(60),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_events_occurred_idx ON auth_events (occurred_at);

-- Table 2 (WALLETS) was an unused placeholder, dropped by migration 005; see payout_destinations.

-- Table 3: RETAIL_OUTLETS
CREATE TABLE IF NOT EXISTS retail_outlets (
    outlet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outlet_code VARCHAR(50) UNIQUE NOT NULL,
    region VARCHAR(100) NOT NULL,
    monthly_baseline DECIMAL(12,2) NOT NULL
);

-- Table 4: SALES_AGENTS
-- agent_code is what C2B payers type as the BillRefNumber (account number).
CREATE TABLE IF NOT EXISTS sales_agents (
    agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES retail_outlets(outlet_id) ON DELETE RESTRICT,
    -- Outcome-based rating R (spec gh-23): credits from matured clean holds / statement confirmations,
    -- penalties per security-hold event (audited in agent_trust_events). Default 0.5 deviates from the
    -- data dictionary's 1.000 on purpose: trust is earned, never granted on sign-up.
    agent_trust_rating NUMERIC(7,6) NOT NULL DEFAULT 0.5 CHECK (agent_trust_rating BETWEEN 0.000 AND 1.000),
    scored_txn_count INTEGER NOT NULL DEFAULT 0,      -- model-scored verifications with a trust row
    -- Shilling-rounding remainder of the last PAID payout, carried into the next claim (spec gh-11).
    payout_carry_cents INTEGER NOT NULL DEFAULT 0
        CONSTRAINT sales_agents_payout_carry_cents CHECK (payout_carry_cents BETWEEN 0 AND 99),
    agent_code VARCHAR(32) UNIQUE
        CONSTRAINT sales_agents_agent_code_normalised CHECK (agent_code = UPPER(BTRIM(agent_code)) AND agent_code <> '')
        -- It is also the Daraja AccountReference, which is at most 12 characters.
        CONSTRAINT sales_agents_agent_code_length CHECK (char_length(agent_code) <= 12)
);

-- Statement imports (spec gh-6-recon): one row per reconcile:import invocation (dry runs too).
-- The same file (SHA-256) resumes after FAILED and is a recorded no-op after COMPLETED.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_sha256 VARCHAR(64) NOT NULL,
    file_name VARCHAR(255),
    operator_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,  -- an active MERCHANT_ADMIN
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(12) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    short_code VARCHAR(20),
    account VARCHAR(100),
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    rows_total INTEGER NOT NULL DEFAULT 0,
    rows_new INTEGER NOT NULL DEFAULT 0,
    counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    noop_of_run_id UUID,                             -- re-import of a file already COMPLETED by that run
    evidence_path TEXT,                              -- copy of the original file (directory named by its SHA)
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_sha_idx ON reconciliation_runs (file_sha256, status);

-- Intake: every non-duplicate Daraja callback, persisted (redacted) before the ACK.
CREATE TABLE IF NOT EXISTS mpesa_callbacks (
    callback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mpesa_receipt_id VARCHAR(50) UNIQUE NOT NULL,
    raw_payload_hash VARCHAR(80) NOT NULL,           -- keyed HMAC of the bytes as received ("k1:<hex>")
    source_channel VARCHAR(30) NOT NULL CHECK (source_channel IN ('DARAJA_STK', 'C2B')),
    payload JSONB NOT NULL,                          -- redacted: MSISDNs replaced by their HMAC, names removed
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'UNRESOLVED', 'SETTLED', 'FAILED', 'DEAD')),
    attempts INTEGER NOT NULL DEFAULT 0,             -- claims since the last clean outcome
    resolve_attempts INTEGER NOT NULL DEFAULT 0,
    resolve_deadline TIMESTAMPTZ,                    -- UNRESOLVED retries stop here
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    claim_token UUID,                                -- lease fence: every status write checks it
    last_error TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    transaction_id UUID,
    -- Reconciliation (spec gh-6-recon): RECONCILED rows are synthesised from an M-Pesa statement.
    origin VARCHAR(12) NOT NULL DEFAULT 'CALLBACK' CHECK (origin IN ('CALLBACK', 'RECONCILED')),
    reconciliation_run_id UUID REFERENCES reconciliation_runs(run_id) ON DELETE RESTRICT,
    checkout_request_id VARCHAR(100),                -- STK CheckoutRequestID (indexed: no JSONB scans)
    stk_request_id UUID,                             -- RECONCILED: the STK request the statement row was bound to
    confirmed_by_callback_at TIMESTAMPTZ,            -- RECONCILED: the genuine callback arrived later and matched
    confirmed_hash VARCHAR(80)                       -- ... and its keyed hash (later deliveries compare against it)
);
CREATE INDEX IF NOT EXISTS mpesa_callbacks_ready_idx
    ON mpesa_callbacks (next_attempt_at, received_at) WHERE status IN ('PENDING', 'UNRESOLVED');
CREATE INDEX IF NOT EXISTS mpesa_callbacks_processing_idx
    ON mpesa_callbacks (claimed_at) WHERE status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS mpesa_callbacks_open_idx
    ON mpesa_callbacks (status, received_at) WHERE status <> 'SETTLED';
CREATE INDEX IF NOT EXISTS mpesa_callbacks_checkout_idx
    ON mpesa_callbacks (checkout_request_id) WHERE checkout_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mpesa_callbacks_stk_request_idx
    ON mpesa_callbacks (stk_request_id) WHERE stk_request_id IS NOT NULL;

-- STK Push requests initiated by agents (spec gh-5). The row is written PENDING *before* Daraja is
-- called, so a lost Daraja response becomes UNKNOWN (never "did not happen") and its callback can
-- still be attributed by the fallback match (phone HMAC, amount, time window).
CREATE TABLE IF NOT EXISTS stk_requests (
    stk_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_request_id VARCHAR(100) UNIQUE,         -- assigned by Daraja; NULL until accepted
    merchant_request_id VARCHAR(100),
    agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    -- EXPIRED: UNKNOWN / stale PENDING past STK_TTL + 10 min. PAID_UNCONFIRMED: the STK Query sweep
    -- says it was paid but no callback (receipt) arrived. RECONCILE_EXHAUSTED: the sweep gave up.
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CONSTRAINT stk_requests_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'FAILED',
                                                               'EXPIRED', 'PAID_UNCONFIRMED', 'RECONCILE_EXHAUSTED')),
    idempotency_key VARCHAR(100),
    request_fingerprint VARCHAR(80),                 -- keyed HMAC of (phone, amount)
    phone_hash VARCHAR(80),                          -- counterparty HMAC of the customer MSISDN
    phone_mask_hash VARCHAR(80),                     -- HMAC of the visible prefix/suffix (masked statement phones)
    account_reference VARCHAR(12),
    response_code VARCHAR(40),                       -- Daraja ResponseCode / errorCode
    result_code VARCHAR(20),                         -- callback ResultCode of a failed push (1032, 1037, ...)
    error TEXT,
    customer_message TEXT,
    claimed_at TIMESTAMPTZ,                          -- PENDING since
    fallback_bound_at TIMESTAMPTZ,                   -- bound to its callback by the fallback match
    consumed_receipt VARCHAR(50) UNIQUE,             -- one receipt per STK request, ever
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- STK Query reconciliation sweep (spec gh-6-recon): fenced lease, backoff, attempt cap.
    reconcile_attempts INTEGER NOT NULL DEFAULT 0,
    next_reconcile_at TIMESTAMPTZ,
    reconcile_claimed_at TIMESTAMPTZ,
    reconcile_claim_token UUID,
    last_query_result TEXT,                          -- evidence: the last STK Query answer (codes, never PII)
    last_queried_at TIMESTAMPTZ,
    CONSTRAINT stk_requests_agent_idempotency_key UNIQUE (agent_id, idempotency_key),
    CONSTRAINT stk_requests_accepted_has_checkout
        CHECK (status NOT IN ('ACCEPTED', 'PAID_UNCONFIRMED') OR checkout_request_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS stk_requests_fallback_idx ON stk_requests (phone_hash, amount, created_at);
CREATE INDEX IF NOT EXISTS stk_requests_open_idx ON stk_requests (created_at) WHERE status IN ('PENDING', 'UNKNOWN');
CREATE INDEX IF NOT EXISTS stk_requests_reconcile_idx
    ON stk_requests (created_at) WHERE status = 'ACCEPTED' AND consumed_receipt IS NULL;
CREATE INDEX IF NOT EXISTS stk_requests_bind_idx
    ON stk_requests (agent_id, amount, created_at) WHERE consumed_receipt IS NULL;

-- Failed STK callbacks (ResultCode != 0) whose CheckoutRequestID is not on file yet (the callback
-- raced ahead of recording Daraja's answer): applied when that answer is recorded.
CREATE TABLE IF NOT EXISTS stk_failed_callbacks (
    checkout_request_id VARCHAR(100) PRIMARY KEY,
    result_code VARCHAR(20) NOT NULL,
    result_desc TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Security alarms that must survive the log stream. Subject-generic: a receipt (payload mutation,
-- STK replay, cross-channel echo) or a user / refresh family (token reuse, lockout, PIN change).
CREATE TABLE IF NOT EXISTS security_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(40) NOT NULL
        CONSTRAINT security_events_event_type_check CHECK (event_type IN (
        'PAYLOAD_MUTATION', 'STK_RECEIPT_REPLAY', 'STK_CHANNEL_ECHO',
        'REFRESH_TOKEN_REUSE', 'LOGIN_LOCKOUT', 'PIN_CHANGED',
        'ADMIN_UNLOCK', 'ADMIN_DISABLE', 'ADMIN_PIN_RESET',
        'RECONCILE_AMOUNT_MISMATCH', 'PAYMENT_REVERSED', 'RECONCILED_CALLBACK_LATE',
        'RECONCILE_ATTRIBUTION_CONFLICT', 'RECONCILE_NOT_ON_STATEMENT', 'STK_STATUS_CONFLICT',
        'PAYOUT_DESTINATION_CHANGED', 'PAYOUT_STATUS_CHANGED', 'PAYOUT_NAME_MISMATCH')),
    mpesa_receipt_id VARCHAR(50),
    subject_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    family_id UUID,
    stk_request_id UUID,                             -- STK_STATUS_CONFLICT: the request whose status is contradicted
    original_hash VARCHAR(80),
    incoming_hash VARCHAR(80) NOT NULL DEFAULT '',
    detail TEXT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- NULL receipts never conflict, so this only dedups receipt-subject events.
    CONSTRAINT security_events_dedup UNIQUE (event_type, mpesa_receipt_id, incoming_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS security_events_family_dedup
    ON security_events (event_type, family_id) WHERE family_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS security_events_stk_dedup
    ON security_events (event_type, stk_request_id) WHERE stk_request_id IS NOT NULL;
-- The agent's in-app list of recent payout-destination events (spec gh-11).
CREATE INDEX IF NOT EXISTS security_events_payout_destination_idx
    ON security_events (subject_user_id, detected_at) WHERE event_type = 'PAYOUT_DESTINATION_CHANGED';

-- Table 5: TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
    mpesa_receipt_id VARCHAR(50) UNIQUE NOT NULL,
    raw_payload_hash VARCHAR(80) NOT NULL,
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    source_channel VARCHAR(30) NOT NULL CHECK (source_channel IN ('DARAJA_STK', 'C2B', 'POS')),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- payment time (Daraja EAT -> UTC)
    counterparty_hash VARCHAR(100) NOT NULL,         -- HMAC of the payer MSISDN (or of the receipt when absent)
    callback_id UUID REFERENCES mpesa_callbacks(callback_id) ON DELETE RESTRICT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- re-score history is cut at the INITIAL evaluation
);
CREATE INDEX IF NOT EXISTS transactions_agent_time_idx ON transactions (agent_id, timestamp);
-- Two-way reconciliation: callback-origin receipts inside a statement's Time Period.
CREATE INDEX IF NOT EXISTS transactions_time_idx ON transactions (timestamp);

-- Table 6: VERIFICATION_EVENTS (append-only: one INITIAL per transaction, then RESCOREs)
CREATE TABLE IF NOT EXISTS verification_events (
    verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    is_deduplicated BOOLEAN NOT NULL DEFAULT TRUE,
    isolation_forest_score DOUBLE PRECISION,         -- raw float; NULL on fail-safe
    xgboost_fraud_prob DOUBLE PRECISION,             -- raw float; NULL on fail-safe
    model_version VARCHAR(64) NOT NULL,
    decision VARCHAR(12) NOT NULL CHECK (decision IN ('CLEAR', 'QUARANTINE', 'REVIEW')),
    layer2_adjudicated BOOLEAN,
    model_sha256 VARCHAR(64),
    triggered_layer SMALLINT,
    is_fail_safe BOOLEAN NOT NULL DEFAULT FALSE,
    fail_safe_cause VARCHAR(40),
    history_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    history_receipts TEXT[],                         -- receipts actually sent (exact re-score replay)
    reason TEXT,
    kind VARCHAR(10) NOT NULL DEFAULT 'INITIAL' CHECK (kind IN ('INITIAL', 'RESCORE')),
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS verification_events_initial_uq
    ON verification_events (transaction_id) WHERE kind = 'INITIAL';
CREATE INDEX IF NOT EXISTS verification_events_latest_idx
    ON verification_events (transaction_id, evaluated_at DESC);

-- Trust parameters in force (spec gh-23): one row per distinct parameter set, keyed by its SHA-256.
CREATE TABLE IF NOT EXISTS trust_config_snapshots (
    config_hash VARCHAR(64) PRIMARY KEY,
    params JSONB NOT NULL,
    formula_version VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table 7: TRUST_SCORES (extended, spec gh-23): one row per model-scored verification. S_t is
-- recomputable from p_used, agent_rating_used and the snapshot's tx weight; the hold from S_t,
-- amount_factor and the snapshot. velocity / split are an audit snapshot of the scored features.
CREATE TABLE IF NOT EXISTS trust_scores (
    trust_score_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_id UUID NOT NULL UNIQUE REFERENCES verification_events(verification_id) ON DELETE CASCADE,
    velocity_score DECIMAL(8,4) NOT NULL,
    split_ratio_score DECIMAL(5,4) NOT NULL,
    final_trust_index NUMERIC(7,6) NOT NULL,         -- S_t (the freeze compares this stored value)
    transaction_trust NUMERIC(7,6),                  -- 1 - p_used
    p_used NUMERIC(7,6),
    p_source VARCHAR(20) CHECK (p_source IN ('xgb', 'isolation_proxy')),
    agent_rating_used NUMERIC(7,6),                  -- R_eff
    amount_factor NUMERIC(14,6),                     -- m
    hold_seconds INTEGER,                            -- T_hold as computed (the escrow may be quarantined instead)
    hold_reason VARCHAR(12) CHECK (hold_reason IN ('transaction', 'agent', 'amount')),
    config_hash VARCHAR(64) REFERENCES trust_config_snapshots(config_hash) ON DELETE RESTRICT,
    formula_version VARCHAR(16),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS trust_scores_created_idx ON trust_scores (created_at);

-- Every agent rating change (spec gh-23), idempotent per (cause, ref): credits ref the receipt,
-- penalties "event_type:receipt", operator adjustments "operator:<agent_id>:<ref>". The agent FK is
-- ON DELETE RESTRICT on purpose: the rating audit trail must outlive any attempt to delete the agent.
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

-- Table 13: PAYOUT_DESTINATIONS (spec gh-11). An agent's personal M-Pesa payout destination: their
-- login phone, proven theirs by a KES 1.00 B2C payment whose registered name must match full_name.
-- The phone is pinned on the row, so after a phone change a replacement waits out a cooling-off.
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

-- Table 14: PAYOUTS (spec gh-11, part 2). One agent-claimed B2C payout of the whole claimable balance
-- (matured HELD escrows, oldest first, up to PAYOUT_MAX_AMOUNT) to the agent's ACTIVE destination.
-- payout_id is the B2C OriginatorConversationID, recorded before the call; an ambiguous send is
-- UNKNOWN and recovered by Transaction Status, never resent. amount = floor((gross + carry_in) / 100).
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
    consent_hash VARCHAR(64) NOT NULL,                -- SHA-256 of the accepted Fuliza disclosure (AuthorisePayout, #9)
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

-- Table 8: ESCROW_ACCOUNTS
CREATE TABLE IF NOT EXISTS escrow_accounts (
    escrow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID UNIQUE NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
    gross_commission DECIMAL(10,2) NOT NULL,
    hold_period_hours INTEGER NOT NULL DEFAULT 24,
    -- CLAIMED: matured and included in a payout still in flight (payout_id); RELEASED once PAID.
    escrow_status VARCHAR(30) NOT NULL CHECK (escrow_status IN ('HELD', 'CLAIMED', 'QUARANTINED', 'RELEASED')),
    payout_id UUID REFERENCES payouts(payout_id) ON DELETE RESTRICT,
    release_due_at TIMESTAMPTZ NOT NULL,
    security_hold BOOLEAN NOT NULL DEFAULT FALSE,    -- payload mutation: self-heal never touches it
    rescore_attempts INTEGER NOT NULL DEFAULT 0,
    next_rescore_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rescore_claimed_at TIMESTAMPTZ,
    rescore_claim_token UUID,
    hold_seconds INTEGER,                            -- T_hold (spec gh-23); NULL on legacy rows
    quarantine_reason VARCHAR(40)                    -- why a QUARANTINED escrow is quarantined (NULL while HELD)
        CONSTRAINT escrow_accounts_quarantine_reason_check CHECK (quarantine_reason IN (
        'security_hold', 'fail_safe', 'model_decision', 'trust_below_threshold', 'trust_input_invalid')),
    -- Unclaimed reminders (spec gh-11 part 3a): highest stage sent for the cycle this oldest escrow keys.
    unclaimed_reminder_stage SMALLINT NOT NULL DEFAULT 0
        CONSTRAINT escrow_accounts_unclaimed_reminder_stage CHECK (unclaimed_reminder_stage BETWEEN 0 AND 3),
    CONSTRAINT escrow_accounts_claimed_payout CHECK (escrow_status <> 'CLAIMED' OR payout_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS escrow_accounts_claimable_idx
    ON escrow_accounts (release_due_at) WHERE escrow_status = 'HELD' AND NOT security_hold;
CREATE INDEX IF NOT EXISTS escrow_accounts_payout_idx ON escrow_accounts (payout_id) WHERE payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS escrow_accounts_rescore_idx
    ON escrow_accounts (next_rescore_at) WHERE escrow_status = 'QUARANTINED' AND NOT security_hold;
-- Trust maturity sweep (spec gh-23): matured holds decided under the trust regime.
CREATE INDEX IF NOT EXISTS escrow_accounts_matured_idx
    ON escrow_accounts (release_due_at) WHERE escrow_status IN ('HELD', 'CLAIMED', 'RELEASED') AND hold_seconds IS NOT NULL;

-- Reconciliation exceptions an operator must act on (spec gh-6-recon): a reversal of a payment whose
-- escrow was already RELEASED (CLAWBACK_DUE), or a RELEASED payment missing from the statement.
-- Nothing is ever paid out or clawed back automatically.
CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
    exception_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind VARCHAR(30) NOT NULL CHECK (kind IN ('CLAWBACK_DUE', 'RELEASED_NOT_ON_STATEMENT')),
    mpesa_receipt_id VARCHAR(50) NOT NULL,
    related_receipt_id VARCHAR(50) NOT NULL DEFAULT '', -- the reversal's own receipt ('' when none)
    run_id UUID REFERENCES reconciliation_runs(run_id) ON DELETE RESTRICT,
    escrow_id UUID REFERENCES escrow_accounts(escrow_id) ON DELETE RESTRICT,
    amount DECIMAL(12,2),
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT reconciliation_exceptions_dedup UNIQUE (kind, mpesa_receipt_id, related_receipt_id)
);

-- Table 9: LEDGER_ENTRIES
CREATE TABLE IF NOT EXISTS ledger_entries (
    ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id UUID NOT NULL REFERENCES escrow_accounts(escrow_id) ON DELETE RESTRICT,
    prev_block_hash VARCHAR(64) NOT NULL,
    current_block_hash VARCHAR(64) NOT NULL,
    block_number BIGINT NOT NULL,
    committed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Table 10: CANARY_PINGS
CREATE TABLE IF NOT EXISTS canary_pings (
    canary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id UUID NOT NULL REFERENCES escrow_accounts(escrow_id) ON DELETE RESTRICT,
    fuliza_intercept_flag BOOLEAN NOT NULL,
    probe_amount DECIMAL(6,2) NOT NULL DEFAULT 1.00,
    latency_ms INTEGER NOT NULL
);

-- Table 11: TAX_DEDUCTIONS
CREATE TABLE IF NOT EXISTS tax_deductions (
    tax_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id UUID NOT NULL REFERENCES escrow_accounts(escrow_id) ON DELETE CASCADE,
    kra_withholding_tax DECIMAL(10,2) NOT NULL,
    net_payout_amount DECIMAL(10,2) NOT NULL
);

-- Table 12 (PAYOUT_DISBURSEMENTS) was an unused per-escrow placeholder, dropped by migration 006; see payouts.

-- A fresh install already has every migration's shape.
INSERT INTO schema_migrations (version) VALUES ('001_settlement_pipeline'), ('002_auth_stk_initiation'), ('003_reconciliation'),
                                               ('004_trust_scores'), ('005_payout_destinations'), ('006_payout_claims'),
                                               ('007_unclaimed_reminders')
    ON CONFLICT (version) DO NOTHING;
