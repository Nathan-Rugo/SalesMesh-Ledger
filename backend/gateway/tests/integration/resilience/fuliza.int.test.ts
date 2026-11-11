/**
 * Fuliza on the payout line (spec gh-15, decision 2026-10-22). Safaricom deducts an outstanding
 * Fuliza balance on the recipient's side after B2C completes; the payer never sees it
 * (docs/architecture/commission-chaincode.md, "Canary = payout preflight"). So the intercept itself
 * cannot be observed or stubbed honestly. What the gateway owns, and what this proves for an
 * indebted line:
 *  - a claim without consent to the CURRENT disclosure version is refused, with no B2C and no payout;
 *  - the consent hash of what the agent accepted is stored;
 *  - exactly one B2C of the full amount is sent and settles PAID; a duplicate result, a
 *    Transaction Status sweep and a repeat claim never resend or top it up.
 */

import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../../../src/auth/auth.service';
import { hashPin } from '../../../src/auth/credentials';
import { LoginThrottle } from '../../../src/auth/throttle';
import { signAccessToken } from '../../../src/auth/tokens';
import { PayoutController } from '../../../src/controllers/payout.controller';
import { B2cClient } from '../../../src/daraja/client';
import { consentHash, DISCLOSURES } from '../../../src/domain/payout';
import { upsertCredential } from '../../../src/repositories/auth.repository';
import { createPayoutRouter } from '../../../src/routes/payout.routes';
import { GatewayMetrics } from '../../../src/services/metrics.service';
import { PayoutService } from '../../../src/services/payout.service';
import { b2cAccepted, b2cResultBody, darajaFetch, TEST_B2C_CONFIG } from '../../support/daraja-fetch';
import { listen, type TestServer } from '../../support/http';
import { MemoryThrottleStore } from '../../support/memory-store';
import { count, createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from '../helpers';

jest.setTimeout(120_000);

const PIN = '4826';

describeDb('resilience: Fuliza-indebted payout line (real Postgres)', () => {
  let db: TestDb;
  let srv: TestServer;
  let service: PayoutService;
  let fake: ReturnType<typeof darajaFetch>;

  beforeAll(async () => {
    db = await createTestDb('sm_fuliza');
    await db.pool.query(INIT_SQL);
    fake = darajaFetch(
      () => ({ status: 500 }),
      undefined,
      () => b2cAccepted({ ConversationID: 'AG_FULIZA_1' }),
      () => b2cAccepted({ ConversationID: 'AG_TS_1' })
    );
    const metrics = new GatewayMetrics();
    service = new PayoutService({
      db: db.pool,
      b2c: new B2cClient({ ...TEST_B2C_CONFIG, timeoutMs: 300 }, fake.fn as any, metrics),
      auth: new AuthService({ db: db.pool, throttle: new LoginThrottle(new MemoryThrottleStore()), metrics }),
      notifier: { send: async () => undefined },
      metrics,
      config: { minAmount: 10, maxAmount: 150_000, statusAfterMs: 0, statusMaxAttempts: 2, disclosureVersion: '1' },
    });
    const app = express();
    app.use('/api/v1/payouts', createPayoutRouter(new PayoutController(service)));
    srv = await listen(app);
  });
  afterAll(async () => {
    await service?.settled();
    jest.restoreAllMocks();
    await srv?.close();
    await db?.drop();
  });
  beforeEach(() => {
    process.env.PAYOUTS_ENABLED = 'true';
    for (const l of ['info', 'warn', 'error'] as const) jest.spyOn(console, l).mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.PAYOUTS_ENABLED;
  });

  it('indebted line: refused without current consent; with it one full-amount B2C → PAID, consent hash stored, never resent or topped up', async () => {
    // The agent's verified line carries an outstanding Fuliza balance (invisible to the payer).
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, null, phone);
    const { rows: [u] } = await db.pool.query(`SELECT user_id FROM sales_agents WHERE agent_id = $1`, [agentId]);
    await upsertCredential(db.pool, u.user_id, await hashPin(PIN), { mustChange: false, oneTimeExpiresAt: null });
    await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [agentId, phone]);
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, 'FULIZA0001', 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId]
    );
    await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds)
       VALUES ($1, 250.00, 'HELD', NOW() - INTERVAL '1 hour', 3600)`,
      [t.transaction_id]
    );
    const token = (await signAccessToken({ userId: u.user_id, role: 'SALES_AGENT', pinChangeRequired: false })).token;
    const claim = (body: Record<string, unknown>) =>
      srv.request('POST', '/api/v1/payouts/claim', { headers: { Authorization: `Bearer ${token}` }, body });
    const payouts = () => count(db.pool, `SELECT count(*) AS n FROM payouts WHERE agent_id = $1`, [agentId]);
    const b2cBefore = fake.calls.b2c;

    // No consent, and consent to a superseded disclosure: refused, nothing sent, nothing recorded.
    for (const body of [{ pin: PIN }, { pin: PIN, disclosure_version: '0' }]) {
      const r = await claim(body);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'disclosure_changed', disclosure: { version: '1', text: DISCLOSURES['1'] } });
    }
    expect(DISCLOSURES['1']).toMatch(/Fuliza/);
    expect(fake.calls.b2c).toBe(b2cBefore);
    expect(await payouts()).toBe(0);

    // Consent to the current version: exactly one B2C of the full floor(balance), consent hash stored.
    const ok = await claim({ pin: PIN, disclosure_version: '1' });
    expect(ok.status).toBe(202);
    const id = ok.body.payout.payout_id;
    expect(fake.calls.b2c - b2cBefore).toBe(1);
    expect(fake.calls.b2cBodies.at(-1)).toMatchObject({ OriginatorConversationID: id, Amount: 250, PartyB: Number(phone) });
    const { rows: [p] } = await db.pool.query(`SELECT * FROM payouts WHERE payout_id = $1`, [id]);
    expect(p).toMatchObject({ status: 'SENT', amount: 250, disclosure_version: '1' });
    expect(p.consent_hash).toBe(
      consentHash({ agentId, payoutId: id, msisdn: phone, amount: 250, disclosureVersion: '1', disclosureText: DISCLOSURES['1'], acceptedAt: new Date(p.accepted_at) })
    );

    // Safaricom reports success (the Fuliza deduction happens after this, on the agent's side).
    const result = b2cResultBody(id, { name: `${phone} - TEST AGENT`, conversationId: 'AG_FULIZA_1', receipt: 'FUL1ZA0OK1' });
    expect((await service.handleResult(result))?.kind).toBe('applied');
    expect((await service.handleResult(result))?.kind).toBe('duplicate');
    await service.sweep();
    const again = await claim({ pin: PIN, disclosure_version: '1' });
    expect(again.status).toBe(409); // nothing matured left: no resend, no top-up
    expect(again.body).toMatchObject({ error: 'below_minimum', amount: 0 });
    await service.settled();

    expect(fake.calls.b2c - b2cBefore).toBe(1);
    expect(await payouts()).toBe(1);
    expect((await db.pool.query(`SELECT status, amount, receipt FROM payouts WHERE payout_id = $1`, [id])).rows[0]).toEqual({
      status: 'PAID',
      amount: 250,
      receipt: 'FUL1ZA0OK1',
    });
    expect((await db.pool.query(`SELECT escrow_status FROM escrow_accounts WHERE transaction_id = $1`, [t.transaction_id])).rows[0].escrow_status).toBe('RELEASED');
  });
});
