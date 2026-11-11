/** GET /api/v1/admin/agents without a database: RBAC on the route, masking and shape in the controller. */

import crypto from 'crypto';
import express from 'express';
import { signAccessToken } from '../src/auth/tokens';
import { AdminController } from '../src/controllers/admin.controller';
import { createAdminRouter } from '../src/routes/admin.routes';
import { listen } from './support/http';

const row = (o: Record<string, unknown> = {}) => ({
  agent_code: 'AG1',
  full_name: 'Jane Wanjiku',
  phone_number: '254712345678',
  disabled: false,
  activated: true,
  dest_status: 'ACTIVE',
  dest_msisdn: '254799999999',
  ...o,
});

async function server(rows: unknown[]) {
  const db = { query: jest.fn(async () => ({ rows })) };
  const app = express();
  app.use('/api/v1/admin', createAdminRouter(new AdminController(undefined, db as never)));
  return { srv: await listen(app), db };
}
const bearer = async (role: 'MERCHANT_ADMIN' | 'SALES_AGENT') => ({
  Authorization: `Bearer ${(await signAccessToken({ userId: crypto.randomUUID(), role, pinChangeRequired: false })).token}`,
});

describe('GET /admin/agents', () => {
  it('admin: masked phones only, snake_case shape', async () => {
    const { srv } = await server([row(), row({ agent_code: null, activated: false, disabled: true, dest_status: null, dest_msisdn: null })]);
    const r = await srv.request('GET', '/api/v1/admin/agents', { headers: await bearer('MERCHANT_ADMIN') });
    await srv.close();
    expect(r.status).toBe(200);
    expect(r.body.agents).toEqual([
      { agent_code: 'AG1', full_name: 'Jane Wanjiku', msisdn: '2547******78', activated: true, disabled: false, payout: { status: 'ACTIVE', msisdn: '2547******99' } },
      { agent_code: null, full_name: 'Jane Wanjiku', msisdn: '2547******78', activated: false, disabled: true, payout: null },
    ]);
    expect(JSON.stringify(r.body)).not.toContain('254712345678');
  });

  it('agent token 403 and no token 401, and the database is never queried', async () => {
    const { srv, db } = await server([row()]);
    const a = await srv.request('GET', '/api/v1/admin/agents', { headers: await bearer('SALES_AGENT') });
    const b = await srv.request('GET', '/api/v1/admin/agents');
    await srv.close();
    expect([a.status, b.status]).toEqual([403, 401]);
    expect(db.query).not.toHaveBeenCalled();
  });
});
