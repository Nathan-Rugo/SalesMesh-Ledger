/**
 * Verified payout destinations against real Postgres (spec gh-11): register → B2C result → ACTIVE;
 * phone change → replacement → COOLING_OFF → sweep promotion (old SUPERSEDED); cancellation; expiry;
 * concurrent registrations against the partial unique indexes; events written in the same transaction.
 */

import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../../src/auth/auth.service';
import { hashPin } from '../../src/auth/credentials';
import { LoginThrottle, PayoutVerificationLimiter } from '../../src/auth/throttle';
import { signAccessToken } from '../../src/auth/tokens';
import { PayoutDestinationController } from '../../src/controllers/payout_destination.controller';
import { B2cClient, parseB2cResult } from '../../src/daraja/client';
import { upsertCredential } from '../../src/repositories/auth.repository';
import { createPayoutDestinationRouter } from '../../src/routes/payout_destination.routes';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { PayoutDestinationService } from '../../src/services/payout_destination.service';
import { b2cAccepted, b2cResultBody, darajaFetch, TEST_B2C_CONFIG, type StkHandler } from '../support/daraja-fetch';
import { listen, type TestServer } from '../support/http';
import { MemoryThrottleStore } from '../support/memory-store';
import { count, createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

describeDb('payout destinations (real Postgres)', () => {
  let db: TestDb;
  let srv: TestServer;
  let service: PayoutDestinationService;
  let b2cHandler: StkHandler;
  let fake: ReturnType<typeof darajaFetch>;
  const sent: Array<{ to: string; message: string }> = [];

  beforeAll(async () => {
    process.env.PAYOUTS_ENABLED = 'true';
    db = await createTestDb('sm_payout');
    await db.pool.query(INIT_SQL);
    fake = darajaFetch(() => ({ status: 500 }), undefined, (b, n) => b2cHandler(b, n));
    const metrics = new GatewayMetrics();
    service = new PayoutDestinationService({
      db: db.pool,
      b2c: new B2cClient({ ...TEST_B2C_CONFIG, timeoutMs: 300 }, fake.fn as any, metrics),
      auth: new AuthService({ db: db.pool, throttle: new LoginThrottle(new MemoryThrottleStore()), metrics }),
      limiter: new PayoutVerificationLimiter(new MemoryThrottleStore(), 100),
      notifier: { send: async (to, message) => void sent.push({ to, message }) },
      metrics,
    });
    const app = express();
    app.use('/api/v1/payout-destinations', createPayoutDestinationRouter(new PayoutDestinationController(service)));
    srv = await listen(app);
  });
  afterAll(async () => {
    await service?.settled();
    jest.restoreAllMocks();
    await srv?.close();
    await db?.drop();
    delete process.env.PAYOUTS_ENABLED;
  });
  beforeEach(() => {
    for (const level of ['info', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
    b2cHandler = () => b2cAccepted();
  });

  async function agent(phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`) {
    const agentId = await seedAgent(db.pool, null, phone);
    const { rows: [u] } = await db.pool.query(`SELECT user_id FROM sales_agents WHERE agent_id = $1`, [agentId]);
    await upsertCredential(db.pool, u.user_id, await hashPin('4826'), { mustChange: false, oneTimeExpiresAt: null });
    const token = (await signAccessToken({ userId: u.user_id, role: 'SALES_AGENT', pinChangeRequired: false })).token;
    return { agentId, userId: u.user_id as string, phone, token };
  }
  const post = (token: string) => srv.request('POST', '/api/v1/payout-destinations', { headers: { Authorization: `Bearer ${token}` }, body: { pin: '4826' } });
  const status = async (id: string) => (await db.pool.query(`SELECT status, reject_reason, cooling_off_until FROM payout_destinations WHERE destination_id = $1`, [id])).rows[0];
  /** The B2C result for `id`, carrying the ConversationID Daraja gave us (when it did). */
  async function apply(id: string, name = '254700000000 - TEST AGENT') {
    const { rows: [r] } = await db.pool.query(`SELECT conversation_id FROM payout_destinations WHERE destination_id = $1`, [id]);
    return service.applyResult(parseB2cResult(b2cResultBody(id, { name, conversationId: r.conversation_id ?? 'AG_LATE' }))!);
  }

  it('register → result → ACTIVE; phone change → replacement COOLING_OFF → sweep promotes it, the old one SUPERSEDED', async () => {
    const a = await agent();
    const res = await post(a.token);
    expect(res.status).toBe(202);
    const firstId = res.body.destination.destination_id;
    expect(fake.calls.b2cBodies.at(-1).OriginatorConversationID).toBe(firstId);
    expect(await status(firstId)).toMatchObject({ status: 'PENDING_VERIFICATION' });

    expect((await apply(firstId)).kind).toBe('applied');
    expect(await status(firstId)).toMatchObject({ status: 'ACTIVE' });
    expect((await apply(firstId)).kind).toBe('duplicate');

    // An admin changes the login phone: the new phone is a replacement.
    const newPhone = `2541${crypto.randomInt(10_000_000, 99_999_999)}`;
    await db.pool.query(`UPDATE users SET phone_number = $1 WHERE user_id = $2`, [newPhone, a.userId]);
    const r2 = await post(a.token);
    expect(r2.status).toBe(202);
    const secondId = r2.body.destination.destination_id;
    expect((await post(a.token)).body).toEqual({ error: 'destination_pending' });
    await apply(secondId);
    const cooling = await status(secondId);
    expect(cooling.status).toBe('COOLING_OFF');
    expect(new Date(cooling.cooling_off_until).getTime() - Date.now()).toBeGreaterThan(24 * 3600_000 - 120_000);

    expect(await service.sweep()).toEqual({ promoted: 0, expired: 0 });
    await db.pool.query(`UPDATE payout_destinations SET cooling_off_until = NOW() - INTERVAL '1 second' WHERE destination_id = $1`, [secondId]);
    expect((await service.sweep()).promoted).toBe(1);
    expect(await status(secondId)).toMatchObject({ status: 'ACTIVE' });
    expect(await status(firstId)).toMatchObject({ status: 'SUPERSEDED' });

    const { rows: events } = await db.pool.query(
      `SELECT detail FROM security_events WHERE subject_user_id = $1 AND event_type = 'PAYOUT_DESTINATION_CHANGED' ORDER BY detected_at`,
      [a.userId]
    );
    expect(events.map((e) => e.detail)).toEqual([
      expect.stringMatching(/registered/),
      expect.stringMatching(/verified; active/),
      expect.stringMatching(/registered/),
      expect.stringMatching(/cooling off until/),
      expect.stringMatching(/superseded/),
      expect.stringMatching(/cooling-off ended; active/),
    ]);
    expect(JSON.stringify(events)).not.toContain(a.phone.slice(4, 10));

    const list = await srv.request('GET', '/api/v1/payout-destinations', { headers: { Authorization: `Bearer ${a.token}` } });
    expect(list.body.destinations.map((d: any) => d.status)).toEqual(['ACTIVE', 'SUPERSEDED']);
    expect(list.body.events).toHaveLength(6);
    expect(JSON.stringify(list.body)).not.toContain(newPhone);
  });

  it('a replacement can be cancelled during cooling-off; a name mismatch is REJECTED', async () => {
    const a = await agent();
    const first = (await post(a.token)).body.destination.destination_id;
    await apply(first);
    await db.pool.query(`UPDATE users SET phone_number = $1 WHERE user_id = $2`, [`2547${crypto.randomInt(10_000_000, 99_999_999)}`, a.userId]);
    const second = (await post(a.token)).body.destination.destination_id;
    await apply(second);
    const del = await srv.request('DELETE', `/api/v1/payout-destinations/${second}`, { headers: { Authorization: `Bearer ${a.token}` }, body: { pin: '4826' } });
    expect(del.status).toBe(200);
    expect(await status(second)).toMatchObject({ status: 'CANCELLED' });
    expect(await status(first)).toMatchObject({ status: 'ACTIVE' });

    const third = (await post(a.token)).body.destination.destination_id;
    await apply(third, '254700000000 - SOMEONE ELSE');
    expect(await status(third)).toMatchObject({ status: 'REJECTED', reject_reason: 'name_mismatch' });
  });

  it('Daraja rejects the B2C synchronously (400.002.02) → 502; the row REJECTED b2c_400.002.02 with its event', async () => {
    const a = await agent();
    b2cHandler = () => ({ status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PartyB' } });
    const res = await post(a.token);
    expect(res.status).toBe(502);
    const id = res.body.destination.destination_id;
    expect(await status(id)).toMatchObject({ status: 'REJECTED', reject_reason: 'b2c_400.002.02' });
    expect(
      await count(
        db.pool,
        `SELECT count(*) AS n FROM security_events WHERE subject_user_id = $1 AND event_type = 'PAYOUT_DESTINATION_CHANGED' AND detail LIKE '%rejected (b2c_400.002.02)%'`,
        [a.userId]
      )
    ).toBe(1);
  });

  it('concurrent registrations: one row, one B2C (partial unique index); no result in 30 min → EXPIRED', async () => {
    const a = await agent();
    const before = fake.calls.b2c;
    b2cHandler = () => 'timeout';
    const results = await Promise.all(Array.from({ length: 5 }, () => post(a.token)));
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409, 409, 409]);
    expect(fake.calls.b2c - before).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM payout_destinations WHERE agent_id = $1`, [a.agentId])).toBe(1);

    const id = results.find((r) => r.status === 202)!.body.destination.destination_id;
    expect(await status(id)).toMatchObject({ status: 'PENDING_VERIFICATION' });
    await db.pool.query(`UPDATE payout_destinations SET sent_at = NOW() - INTERVAL '31 minutes' WHERE destination_id = $1`, [id]);
    expect((await service.sweep()).expired).toBe(1);
    expect(await status(id)).toMatchObject({ status: 'EXPIRED', reject_reason: 'no_result' });
    b2cHandler = () => b2cAccepted();
    expect((await post(a.token)).status).toBe(202);
  });
});
