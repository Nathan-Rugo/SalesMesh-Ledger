/**
 * Admin agents directory against real Postgres, over HTTP: MERCHANT_ADMIN only; phones always masked;
 * activated / disabled flags and the payout destination summary come from the real tables.
 */

import crypto from 'crypto';
import express from 'express';
import { hashPin } from '../../src/auth/credentials';
import { signAccessToken } from '../../src/auth/tokens';
import { AdminController } from '../../src/controllers/admin.controller';
import { upsertCredential } from '../../src/repositories/auth.repository';
import { createAdminRouter } from '../../src/routes/admin.routes';
import { listen, type TestServer } from '../support/http';
import { createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

describeDb('admin agents directory (real Postgres)', () => {
  let db: TestDb;
  let srv: TestServer;

  beforeAll(async () => {
    db = await createTestDb('sm_admin_ag');
    await db.pool.query(INIT_SQL);
    const app = express();
    app.use('/api/v1/admin', createAdminRouter(new AdminController(undefined, db.pool)));
    srv = await listen(app);
  });
  afterAll(async () => {
    await srv?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE users CASCADE`);
  });

  async function user(role: 'MERCHANT_ADMIN' | 'SALES_AGENT') {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const { rows: [u] } = await db.pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ('Ops', $1, $2) RETURNING user_id`, [phone, role]);
    return { userId: u.user_id as string, token: (await signAccessToken({ userId: u.user_id, role, pinChangeRequired: false })).token };
  }
  const get = (token: string | null) =>
    srv.request('GET', '/api/v1/admin/agents', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const userOf = async (agentId: string) =>
    (await db.pool.query(`SELECT user_id FROM sales_agents WHERE agent_id = $1`, [agentId])).rows[0].user_id as string;

  it('lists agents with masked phones, flags and payout summary; never a raw number', async () => {
    const admin = await user('MERCHANT_ADMIN');
    const phoneA = '254711223344';
    const phoneC = '254722334455';
    const idA = await seedAgent(db.pool, 'AG0001', phoneA);
    await seedAgent(db.pool, 'AG0002');
    const idC = await seedAgent(db.pool, 'AG0003', phoneC);
    await upsertCredential(db.pool, await userOf(idA), await hashPin('4826'), { mustChange: false, oneTimeExpiresAt: null });
    const uc = await userOf(idC);
    await upsertCredential(db.pool, uc, await hashPin('4826'), { mustChange: true, oneTimeExpiresAt: new Date(Date.now() + 1e6) });
    await db.pool.query(`UPDATE users SET disabled_at = NOW() WHERE user_id = $1`, [uc]);
    await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [idA, phoneA]);

    const r = await get(admin.token);
    expect(r.status).toBe(200);
    expect(r.body.agents).toEqual([
      { agent_code: 'AG0001', full_name: 'Test Agent', msisdn: '2547******44', activated: true, disabled: false, payout: { status: 'ACTIVE', msisdn: '2547******44' } },
      expect.objectContaining({ agent_code: 'AG0002', activated: false, disabled: false, payout: null }),
      { agent_code: 'AG0003', full_name: 'Test Agent', msisdn: '2547******55', activated: false, disabled: true, payout: null },
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/254711223344|254722334455/);
  });

  it('excludes admins; agent token 403, no token 401', async () => {
    const admin = await user('MERCHANT_ADMIN');
    const agentUser = await user('SALES_AGENT');
    expect((await get(admin.token)).body.agents).toEqual([]);
    expect(await get(agentUser.token)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await get(null)).status).toBe(401);
  });
});
