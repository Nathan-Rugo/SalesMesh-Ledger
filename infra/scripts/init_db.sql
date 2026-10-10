-- SalesMesh Physical Database DDL Schema (fresh install)
-- Aligned with Chapter 4 Data Dictionary (Tables 4.6 - 4.17), plus the settlement-pipeline
-- tables (mpesa_callbacks, stk_requests, security_events) from spec gh-6, the auth / STK
-- initiation tables (user_credentials, refresh_tokens, auth_events) from spec gh-5, and the Daraja
-- reconciliation tables (reconciliation_runs, reconciliation_exceptions) from spec gh-6-recon.
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

-- Table 2: WALLETS
CREATE TABLE IF NOT EXISTS wallets (
    wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    wallet_type VARCHAR(30) NOT NULL CHECK (wallet_type IN ('MPESA_B2C', 'BANK_PAYSTACK')),
    account_id VARCHAR(100) NOT NULL
);

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
    agent_trust_rating DECIMAL(4,3) NOT NULL DEFAULT 1.000 CHECK (agent_trust_rating BETWEEN 0.000 AND 1.000),
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
        'RECONCILE_ATTRIBUTION_CONFLICT', 'RECONCILE_NOT_ON_STATEMENT', 'STK_STATUS_CONFLICT')),
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

-- Table 7: TRUST_SCORES
CREATE TABLE IF NOT EXISTS trust_scores (
    trust_score_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_id UUID NOT NULL REFERENCES verification_events(verification_id) ON DELETE CASCADE,
    velocity_score DECIMAL(8,4) NOT NULL,
    split_ratio_score DECIMAL(5,4) NOT NULL,
    final_trust_index DECIMAL(5,4) NOT NULL
);

-- Table 8: ESCROW_ACCOUNTS
CREATE TABLE IF NOT EXISTS escrow_accounts (
    escrow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID UNIQUE NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
    gross_commission DECIMAL(10,2) NOT NULL,
    hold_period_hours INTEGER NOT NULL DEFAULT 24,
    escrow_status VARCHAR(30) NOT NULL CHECK (escrow_status IN ('HELD', 'QUARANTINED', 'RELEASED')),
    release_due_at TIMESTAMPTZ NOT NULL,
    security_hold BOOLEAN NOT NULL DEFAULT FALSE,    -- payload mutation: self-heal never touches it
    rescore_attempts INTEGER NOT NULL DEFAULT 0,
    next_rescore_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rescore_claimed_at TIMESTAMPTZ,
    rescore_claim_token UUID
);
CREATE INDEX IF NOT EXISTS escrow_accounts_rescore_idx
    ON escrow_accounts (next_rescore_at) WHERE escrow_status = 'QUARANTINED' AND NOT security_hold;

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

-- Table 12: PAYOUT_DISBURSEMENTS
CREATE TABLE IF NOT EXISTS payout_disbursements (
    payout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id UUID NOT NULL REFERENCES escrow_accounts(escrow_id) ON DELETE RESTRICT,
    conversation_id VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(30) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'REVERSED')),
    disbursed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- A fresh install already has every migration's shape.
INSERT INTO schema_migrations (version) VALUES ('001_settlement_pipeline'), ('002_auth_stk_initiation'), ('003_reconciliation')
    ON CONFLICT (version) DO NOTHING;
