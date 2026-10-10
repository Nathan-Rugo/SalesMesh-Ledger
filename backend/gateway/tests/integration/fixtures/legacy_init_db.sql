-- SalesMesh Physical Database DDL Schema
-- Aligned with Chapter 4 Data Dictionary (Tables 4.6 - 4.17)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table 1: USERS
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('MERCHANT_ADMIN', 'SALES_AGENT')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

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
CREATE TABLE IF NOT EXISTS sales_agents (
    agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    outlet_id UUID NOT NULL REFERENCES retail_outlets(outlet_id) ON DELETE RESTRICT,
    agent_trust_rating DECIMAL(4,3) NOT NULL DEFAULT 1.000 CHECK (agent_trust_rating BETWEEN 0.000 AND 1.000)
);

-- Table 5: TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES sales_agents(agent_id) ON DELETE RESTRICT,
    mpesa_receipt_id VARCHAR(50) UNIQUE NOT NULL,
    raw_payload_hash VARCHAR(64) NOT NULL,
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    source_channel VARCHAR(30) NOT NULL CHECK (source_channel IN ('DARAJA_STK', 'C2B', 'POS')),
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Table 6: VERIFICATION_EVENTS
CREATE TABLE IF NOT EXISTS verification_events (
    verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID UNIQUE NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    is_deduplicated BOOLEAN NOT NULL DEFAULT TRUE,
    isolation_forest_score DECIMAL(5,4) NOT NULL,
    xgboost_fraud_prob DECIMAL(5,4) NOT NULL,
    model_version VARCHAR(20) NOT NULL
);

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
    transaction_id UUID NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
    gross_commission DECIMAL(10,2) NOT NULL,
    hold_period_hours INTEGER NOT NULL DEFAULT 24,
    escrow_status VARCHAR(30) NOT NULL CHECK (escrow_status IN ('HELD', 'QUARANTINED', 'RELEASED')),
    release_due_at TIMESTAMP NOT NULL
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