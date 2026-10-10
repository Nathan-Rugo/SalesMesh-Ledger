/**
 * Migrations 001 + 002 against real Postgres: legacy schema + 001 + 002 == fresh init schema,
 * legacy rows are backfilled, and re-running (or running on a fresh install) is a no-op.
 */

import type { Pool } from 'pg';
import { createTestDb, describeDb, INIT_SQL, LEGACY_SQL, MIGRATION_001, MIGRATION_002, type TestDb } from './helpers';

jest.setTimeout(60_000);

async function shape(pool: Pool) {
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length, column_default
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`
  );
  const idx = await pool.query(`SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`);
  const cons = await pool.query(
    `SELECT conrelid::regclass::text AS t, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace`
  );
  const consSorted = cons.rows.map((r) => `${r.t}|${r.contype}|${r.def}`).sort();
  return { cols: cols.rows, idx: idx.rows, cons: consSorted };
}

describeDb('migrations 001_settlement_pipeline + 002_auth_stk_initiation', () => {
  let legacy: TestDb;
  let fresh: TestDb;

  beforeAll(async () => {
    legacy = await createTestDb('sm_mig_legacy');
    fresh = await createTestDb('sm_mig_fresh');
    await legacy.pool.query(LEGACY_SQL);
    await fresh.pool.query(INIT_SQL);
  });
  afterAll(async () => {
    await legacy?.drop();
    await fresh?.drop();
  });

  it('backfills legacy rows and brings the legacy schema to the fresh-install shape', async () => {
    const p = legacy.pool;
    const { rows: [u] } = await p.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('a', '254700000001', 'SALES_AGENT') RETURNING user_id`);
    const { rows: [o] } = await p.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('O1', 'r', 1) RETURNING outlet_id`);
    const { rows: [a] } = await p.query(`INSERT INTO sales_agents (user_id, outlet_id) VALUES ($1, $2) RETURNING agent_id`, [u.user_id, o.outlet_id]);
    const { rows: [t] } = await p.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, timestamp)
       VALUES ($1, 'LEGACY0001', $2, 100, 'C2B', '2026-01-01 10:00:00') RETURNING transaction_id`,
      [a.agent_id, 'e'.repeat(64)]
    );
    await p.query(
      `INSERT INTO verification_events (transaction_id, isolation_forest_score, xgboost_fraud_prob, model_version)
       VALUES ($1, -1, -1, 'v1.0.0-failsafe')`,
      [t.transaction_id]
    );
    await p.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at)
       VALUES ($1, 10, 'QUARANTINED', '2026-01-04 10:00:00')`,
      [t.transaction_id]
    );

    await p.query(MIGRATION_001);

    const { rows: [tx] } = await p.query(`SELECT counterparty_hash, timestamp, ingested_at FROM transactions`);
    expect(tx.counterparty_hash).toBe('legacy:LEGACY0001');
    expect(new Date(tx.timestamp).toISOString()).toBe('2026-01-01T10:00:00.000Z');
    const { rows: [ve] } = await p.query(`SELECT * FROM verification_events`);
    expect(ve).toMatchObject({ decision: 'QUARANTINE', kind: 'INITIAL', is_fail_safe: true, isolation_forest_score: null, xgboost_fraud_prob: null });
    const { rows: [es] } = await p.query(`SELECT release_due_at, security_hold, rescore_attempts FROM escrow_accounts`);
    expect(new Date(es.release_due_at).toISOString()).toBe('2026-01-04T10:00:00.000Z');
    expect(es).toMatchObject({ security_hold: false, rescore_attempts: 0 });

    // Re-score history may now be appended for the same transaction.
    await p.query(
      `INSERT INTO verification_events (transaction_id, model_version, decision, kind) VALUES ($1, 'v1.0.0', 'CLEAR', 'RESCORE')`,
      [t.transaction_id]
    );
    await expect(
      p.query(`INSERT INTO verification_events (transaction_id, model_version, decision) VALUES ($1, 'v', 'CLEAR')`, [t.transaction_id])
    ).rejects.toThrow(/verification_events_initial_uq/);

    // A pre-002 STK request (old shape: CheckoutRequestID primary key), consumed by a receipt.
    await p.query(
      `INSERT INTO stk_requests (checkout_request_id, agent_id, amount, consumed_receipt) VALUES ('ws_CO_legacy', $1, 1500, 'LEGACY0001')`,
      [a.agent_id]
    );
    await p.query(MIGRATION_002);
    const { rows: [stk] } = await p.query(`SELECT * FROM stk_requests`);
    expect(stk).toMatchObject({ checkout_request_id: 'ws_CO_legacy', status: 'ACCEPTED', consumed_receipt: 'LEGACY0001', idempotency_key: null });
    expect(stk.stk_request_id).toMatch(/^[0-9a-f-]{36}$/);
    // The worker's replay guard still relies on this constraint name.
    await expect(
      p.query(`INSERT INTO stk_requests (agent_id, amount, status, consumed_receipt) VALUES ($1, 10, 'UNKNOWN', 'LEGACY0001')`, [a.agent_id])
    ).rejects.toMatchObject({ constraint: 'stk_requests_consumed_receipt_key' });
    // Subject-generic security events (no receipt).
    await p.query(`INSERT INTO security_events (event_type, subject_user_id, detail) VALUES ('LOGIN_LOCKOUT', $1, 'x')`, [u.user_id]);

    const [a1, b1] = await Promise.all([shape(legacy.pool), shape(fresh.pool)]);
    expect(a1.cols).toEqual(b1.cols);
    expect(a1.idx).toEqual(b1.idx);
    expect(a1.cons).toEqual(b1.cons);
  });

  it('is a no-op when re-run, and on a fresh install', async () => {
    const before = await shape(legacy.pool);
    await legacy.pool.query(MIGRATION_001);
    await legacy.pool.query(MIGRATION_002);
    expect(await shape(legacy.pool)).toEqual(before);

    const freshBefore = await shape(fresh.pool);
    await fresh.pool.query(MIGRATION_001);
    await fresh.pool.query(MIGRATION_002);
    expect(await shape(fresh.pool)).toEqual(freshBefore);
    const { rows } = await fresh.pool.query(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(rows.map((r) => r.version)).toEqual(['001_settlement_pipeline', '002_auth_stk_initiation']);
  });

  it('enforces the agent_code CHECK (upper-case, trimmed)', async () => {
    const p = fresh.pool;
    const { rows: [u] } = await p.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('a', '254700000009', 'SALES_AGENT') RETURNING user_id`);
    const { rows: [o] } = await p.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('O9', 'r', 1) RETURNING outlet_id`);
    await expect(
      p.query(`INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, ' ag042 ')`, [u.user_id, o.outlet_id])
    ).rejects.toThrow(/sales_agents_agent_code_normalised/);
    await p.query(`INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, 'AG042')`, [u.user_id, o.outlet_id]);
  });

  it('enforces the agent_code length (Daraja AccountReference <= 12); 002 refuses longer legacy codes', async () => {
    const p = fresh.pool;
    const { rows: [u] } = await p.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('a', '254700000010', 'SALES_AGENT') RETURNING user_id`);
    const { rows: [o] } = await p.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('O10', 'r', 1) RETURNING outlet_id`);
    await expect(
      p.query(`INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, 'ABCDEFGHIJKLM')`, [u.user_id, o.outlet_id])
    ).rejects.toThrow(/sales_agents_agent_code_length/);

    const long = await createTestDb('sm_mig_long');
    try {
      await long.pool.query(LEGACY_SQL);
      await long.pool.query(MIGRATION_001);
      const { rows: [u2] } = await long.pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('a', '254700000011', 'SALES_AGENT') RETURNING user_id`);
      const { rows: [o2] } = await long.pool.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('O11', 'r', 1) RETURNING outlet_id`);
      await long.pool.query(`INSERT INTO sales_agents (user_id, outlet_id, agent_code) VALUES ($1, $2, 'ABCDEFGHIJKLM')`, [u2.user_id, o2.outlet_id]);
      await expect(long.pool.query(MIGRATION_002)).rejects.toThrow(/longer than 12 characters.*ABCDEFGHIJKLM/);
    } finally {
      await long.drop();
    }
  });

  it('aborts with the duplicated transaction_ids when legacy escrows are duplicated; honours salesmesh.legacy_tz', async () => {
    const dup = await createTestDb('sm_mig_dup');
    try {
      const p = dup.pool;
      await p.query(LEGACY_SQL);
      const { rows: [u] } = await p.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('a', '254700000002', 'SALES_AGENT') RETURNING user_id`);
      const { rows: [o] } = await p.query(`INSERT INTO retail_outlets (outlet_code, region, monthly_baseline) VALUES ('O2', 'r', 1) RETURNING outlet_id`);
      const { rows: [a] } = await p.query(`INSERT INTO sales_agents (user_id, outlet_id) VALUES ($1, $2) RETURNING agent_id`, [u.user_id, o.outlet_id]);
      const { rows: [t] } = await p.query(
        `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, timestamp)
         VALUES ($1, 'LEGACY0002', 'h', 100, 'C2B', '2026-01-01 12:00:00') RETURNING transaction_id`,
        [a.agent_id]
      );
      for (let i = 0; i < 2; i++) {
        await p.query(
          `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at) VALUES ($1, 10, 'HELD', NOW())`,
          [t.transaction_id]
        );
      }
      await expect(p.query(MIGRATION_001)).rejects.toThrow(new RegExp(`duplicate escrows.*${t.transaction_id}`));
      await p.query('ROLLBACK').catch(() => undefined);

      // Remediate, then migrate with legacy timestamps written in EAT.
      await p.query(`DELETE FROM escrow_accounts WHERE ctid IN (SELECT ctid FROM escrow_accounts LIMIT 1)`);
      const client = await p.connect();
      try {
        await client.query(`SET salesmesh.legacy_tz = 'Africa/Nairobi'`);
        await client.query(MIGRATION_001);
      } finally {
        client.release();
      }
      const { rows: [tx] } = await p.query(`SELECT timestamp FROM transactions`);
      expect(new Date(tx.timestamp).toISOString()).toBe('2026-01-01T09:00:00.000Z');
    } finally {
      await dup.drop();
    }
  });
});
