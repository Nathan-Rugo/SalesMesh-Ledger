/**
 * Agent-claimed payouts against real Postgres (spec gh-11, part 2): one test per I/O-matrix row over
 * HTTP, with Daraja (B2C + Transaction Status) and SMS faked; the claim race (two concurrent claims →
 * one 202, one 409, one B2C); carry arithmetic across claims; duplicate / late results change state,
 * escrows and carry at most once; Transaction Status recovery never resends the payment.
 */

import crypto from 'crypto';
import express from 'express';
import { AuthService } from '../../src/auth/auth.service';
import { hashPin } from '../../src/auth/credentials';
import { LoginThrottle } from '../../src/auth/throttle';
import { signAccessToken } from '../../src/auth/tokens';
import { PayoutController } from '../../src/controllers/payout.controller';
import { B2cClient } from '../../src/daraja/client';
import { consentHash, DISCLOSURES } from '../../src/domain/payout';
import { upsertCredential } from '../../src/repositories/auth.repository';
import { securityHoldReceipt } from '../../src/repositories/security.repository';
import { createPayoutRouter } from '../../src/routes/payout.routes';
import { payoutResolve } from '../../src/scripts/payout-resolve';
import { GatewayMetrics } from '../../src/services/metrics.service';
import { PayoutService } from '../../src/services/payout.service';
import { b2cAccepted, b2cResultBody, darajaFetch, TEST_B2C_CONFIG, tsResultBody, type StkHandler } from '../support/daraja-fetch';
import { listen, type TestServer } from '../support/http';
import { MemoryThrottleStore } from '../support/memory-store';
import { count, createTestDb, describeDb, INIT_SQL, seedAgent, type TestDb } from './helpers';

jest.setTimeout(120_000);

const PIN = '4826';

describeDb('agent-claimed payouts (real Postgres)', () => {
  let db: TestDb;
  let srv: TestServer;
  let service: PayoutService;
  let b2cHandler: StkHandler;
  let tsHandler: StkHandler;
  let fake: ReturnType<typeof darajaFetch>;
  let sent: Array<{ to: string; message: string }>;

  beforeAll(async () => {
    db = await createTestDb('sm_claims');
    await db.pool.query(INIT_SQL);
    fake = darajaFetch(
      () => ({ status: 500 }),
      undefined,
      (b, n) => b2cHandler(b, n),
      (b, n) => tsHandler(b, n)
    );
    const metrics = new GatewayMetrics();
    service = new PayoutService({
      db: db.pool,
      b2c: new B2cClient({ ...TEST_B2C_CONFIG, timeoutMs: 300 }, fake.fn as any, metrics),
      auth: new AuthService({ db: db.pool, throttle: new LoginThrottle(new MemoryThrottleStore()), metrics }),
      notifier: { send: async (to, message) => void sent.push({ to, message }) },
      metrics,
      config: { minAmount: 10, maxAmount: 150_000, statusAfterMs: 3_600_000, statusMaxAttempts: 2, disclosureVersion: '1' },
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
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    process.env.PAYOUTS_ENABLED = 'true';
    logs = (['info', 'warn', 'error'] as const).map((l) => jest.spyOn(console, l).mockImplementation(() => undefined));
    b2cHandler = () => b2cAccepted({ ConversationID: 'AG_PAY_1' });
    tsHandler = () => b2cAccepted({ ConversationID: 'AG_TS_1' });
    sent = [];
  });
  afterEach(async () => {
    await service.settled();
    const logged = logs.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    // Never a full MSISDN, the registered name, or the initiator credential in a log line.
    expect(logged).not.toMatch(/2547\d{8}|TEST AGENT|SECURITY-CREDENTIAL/);
    logs.forEach((s) => s.mockRestore());
    delete process.env.PAYOUTS_ENABLED;
  });

  /** An agent with a PIN, an ACTIVE verified destination (its login phone) and a token. */
  async function agent(o: { destination?: 'ACTIVE' | 'none' } = {}) {
    const phone = `2547${crypto.randomInt(10_000_000, 99_999_999)}`;
    const agentId = await seedAgent(db.pool, null, phone);
    const { rows: [u] } = await db.pool.query(`SELECT user_id FROM sales_agents WHERE agent_id = $1`, [agentId]);
    await upsertCredential(db.pool, u.user_id, await hashPin(PIN), { mustChange: false, oneTimeExpiresAt: null });
    if (o.destination !== 'none') {
      await db.pool.query(`INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at) VALUES ($1, $2, 'ACTIVE', NOW())`, [agentId, phone]);
    }
    const token = (await signAccessToken({ userId: u.user_id, role: 'SALES_AGENT', pinChangeRequired: false })).token;
    return { agentId, userId: u.user_id as string, phone, token };
  }

  /** A settled payment with its escrow (gross commission in shillings, e.g. '12.34'). */
  async function escrow(agentId: string, gross: string, o: { matured?: boolean; status?: string } = {}) {
    const receipt = `R${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows: [t] } = await db.pool.query(
      `INSERT INTO transactions (agent_id, mpesa_receipt_id, raw_payload_hash, amount, source_channel, counterparty_hash)
       VALUES ($1, $2, 'h', 1000, 'C2B', 'c') RETURNING transaction_id`,
      [agentId, receipt]
    );
    const { rows: [e] } = await db.pool.query(
      `INSERT INTO escrow_accounts (transaction_id, gross_commission, escrow_status, release_due_at, hold_seconds)
       VALUES ($1, $2::numeric, $3, NOW() + ($4 || ' hours')::interval, 3600) RETURNING escrow_id`,
      [t.transaction_id, gross, o.status ?? 'HELD', o.matured === false ? '1' : '-1']
    );
    return { escrowId: e.escrow_id as string, receipt };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const claim = (token: string, body: Record<string, unknown> = { pin: PIN, disclosure_version: '1' }) =>
    srv.request('POST', '/api/v1/payouts/claim', { headers: auth(token), body });
  const get = (token: string) => srv.request('GET', '/api/v1/payouts', { headers: auth(token) });
  const payout = async (id: string) => (await db.pool.query(`SELECT * FROM payouts WHERE payout_id = $1`, [id])).rows[0];
  const escrowRow = async (id: string) => (await db.pool.query(`SELECT escrow_status, payout_id, security_hold, quarantine_reason FROM escrow_accounts WHERE escrow_id = $1`, [id])).rows[0];
  const carry = async (agentId: string) => (await db.pool.query(`SELECT payout_carry_cents FROM sales_agents WHERE agent_id = $1`, [agentId])).rows[0].payout_carry_cents;
  const events = async (userId: string, type = 'PAYOUT_STATUS_CHANGED') =>
    (await db.pool.query(`SELECT detail FROM security_events WHERE subject_user_id = $1 AND event_type = $2 ORDER BY detected_at`, [userId, type])).rows.map((r) => r.detail as string);
  /** The latest Transaction Status query id issued for the payout. */
  const lastQuery = async (id: string): Promise<string> => (await payout(id)).status_query_ids.at(-1);
  /** Makes a payout look old enough for the Transaction Status sweep. */
  const age = (id: string) => db.pool.query(`UPDATE payouts SET created_at = NOW() - INTERVAL '2 hours', next_status_at = NULL WHERE payout_id = $1`, [id]);

  it('claim → 202 SENT, one B2C of floor(balance) to the ACTIVE destination; result OK → PAID, escrows RELEASED, carry kept; duplicates change nothing', async () => {
    const a = await agent();
    const e1 = await escrow(a.agentId, '1234.56');
    const e2 = await escrow(a.agentId, '0.67');
    const notYet = await escrow(a.agentId, '500.00', { matured: false });

    const view = await get(a.token);
    expect(view.status).toBe(200);
    expect(view.body.balance).toMatchObject({ amount: 1235, cents: 123523, escrows: 2, carry_cents: 0, payable_now: 1235 });
    expect(view.body.disclosure).toEqual({ version: '1', text: DISCLOSURES['1'] });
    expect(view.body.destination).toMatch(/^2547\*{6}\d{2}$/);

    const before = fake.calls.b2c;
    const res = await claim(a.token);
    expect(res.status).toBe(202);
    expect(res.body.payout).toMatchObject({ status: 'SENT', amount: 1235, msisdn: expect.stringMatching(/\*{6}/) });
    const id = res.body.payout.payout_id;
    expect(fake.calls.b2c - before).toBe(1);
    expect(fake.calls.b2cBodies.at(-1)).toMatchObject({ OriginatorConversationID: id, CommandID: 'BusinessPayment', Amount: 1235, PartyB: Number(a.phone) });
    for (const e of [e1, e2]) expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'CLAIMED', payout_id: id });
    expect(await escrowRow(notYet.escrowId)).toMatchObject({ escrow_status: 'HELD', payout_id: null });

    const p = await payout(id);
    expect(p).toMatchObject({ status: 'SENT', amount: 1235, gross_cents: '123523', carry_in_cents: 0, carry_out_cents: 23, conversation_id: 'AG_PAY_1', disclosure_version: '1' });
    expect(p.consent_hash).toBe(
      consentHash({ agentId: a.agentId, payoutId: id, msisdn: a.phone, amount: 1235, disclosureVersion: '1', disclosureText: DISCLOSURES['1'], acceptedAt: new Date(p.accepted_at) })
    );

    const ok = b2cResultBody(id, { name: `${a.phone} - TEST AGENT`, conversationId: 'AG_PAY_1' });
    expect((await service.handleResult(ok))?.kind).toBe('applied');
    expect(await payout(id)).toMatchObject({ status: 'PAID', receipt: 'NLJ41HAY6Q', result_code: '0' });
    for (const e of [e1, e2]) expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'RELEASED' });
    expect(await carry(a.agentId)).toBe(23);

    // Duplicate and late (contradicting) results: state, escrows and carry change at most once.
    expect((await service.handleResult(ok))?.kind).toBe('duplicate');
    expect((await service.handleResult(b2cResultBody(id, { code: 2001, conversationId: 'AG_PAY_1' })))?.kind).toBe('duplicate');
    expect(await payout(id)).toMatchObject({ status: 'PAID' });
    expect(await carry(a.agentId)).toBe(23);
    await service.settled();
    expect(sent.map((s) => s.to)).toEqual([a.phone, a.phone]);
    expect(sent[1].message).toMatch(/KES 1235 commission paid .* receipt NLJ41HAY6Q/);
    expect((await events(a.userId)).map((d) => d.replace(/payout \S+ /, ''))).toEqual([
      expect.stringMatching(/claimed \(2 escrow\(s\), disclosure v1\)/),
      expect.stringMatching(/paid \(B2C result\), receipt NLJ41HAY6Q/),
      expect.stringMatching(/CONFLICT: FAILED B2C result for a PAID payout$/),
    ]);
    expect(await events(a.userId, 'PAYOUT_NAME_MISMATCH')).toEqual([]);

    // Carry arithmetic: the 23 cents join the next claim (10.80 + 0.23 = 11.03 → KES 11, carry 3).
    await db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - INTERVAL '1 minute' WHERE escrow_id = $1`, [notYet.escrowId]);
    await db.pool.query(`UPDATE escrow_accounts SET gross_commission = 10.80 WHERE escrow_id = $1`, [notYet.escrowId]);
    const next = await claim(a.token);
    expect(next.status).toBe(202);
    expect(await payout(next.body.payout.payout_id)).toMatchObject({ amount: 11, gross_cents: '1080', carry_in_cents: 23, carry_out_cents: 3 });
    await service.handleResult(b2cResultBody(next.body.payout.payout_id, { name: 'TEST AGENT', conversationId: 'AG_PAY_1', receipt: 'NEXT000001' }));
    expect(await carry(a.agentId)).toBe(3);
  });

  it('result fail → FAILED b2c_<code>, escrows HELD again, carry unchanged, SMS; the balance can be claimed again', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '50.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    expect((await service.handleResult(b2cResultBody(id, { code: 2001, conversationId: 'AG_PAY_1' })))?.kind).toBe('applied');
    expect(await payout(id)).toMatchObject({ status: 'FAILED', failure_reason: 'b2c_2001', result_code: '2001' });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'HELD', payout_id: null });
    expect(await carry(a.agentId)).toBe(0);
    await service.settled();
    expect(sent.at(-1)!.message).toMatch(/did not go through/);
    expect((await claim(a.token)).status).toBe(202);
  });

  it('name drift: an OK result whose name differs from full_name → PAID plus PAYOUT_NAME_MISMATCH', async () => {
    const a = await agent();
    await escrow(a.agentId, '50.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    await service.handleResult(b2cResultBody(id, { name: `${a.phone} - SOMEONE ELSE`, conversationId: 'AG_PAY_1', receipt: 'DRIFT00001' }));
    expect(await payout(id)).toMatchObject({ status: 'PAID' });
    expect(await events(a.userId, 'PAYOUT_NAME_MISMATCH')).toEqual([expect.stringMatching(/no longer matches/)]);
    expect(JSON.stringify(await events(a.userId, 'PAYOUT_NAME_MISMATCH'))).not.toMatch(/SOMEONE/);
  });

  it('not sent (OAuth / network before sending) → 503, FAILED not_sent, escrows released at once; a Daraja rejection → 502', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '50.00');
    b2cHandler = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const res = await claim(a.token);
    expect(res.status).toBe(503);
    expect(res.body.payout).toMatchObject({ status: 'FAILED', failure_reason: 'not_sent' });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'HELD', payout_id: null });

    b2cHandler = () => ({ status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PartyB' } });
    const rej = await claim(a.token);
    expect(rej.status).toBe(502);
    expect(rej.body.payout).toMatchObject({ status: 'FAILED', failure_reason: 'b2c_400.002.02' });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'HELD' });
  });

  it('ambiguous send → 202 UNKNOWN; no second B2C while open (409); Transaction Status recovers PAID', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '75.50');
    b2cHandler = () => 'timeout';
    const res = await claim(a.token);
    expect(res.status).toBe(202);
    expect(res.body.payout.status).toBe('UNKNOWN');
    const id = res.body.payout.payout_id;
    b2cHandler = () => b2cAccepted();
    const b2cBefore = fake.calls.b2c;
    expect((await claim(a.token)).body).toEqual({ error: 'payout_in_progress' });

    // Not old enough yet: no query.
    const tsBefore = fake.calls.ts;
    expect(await service.sweep()).toEqual({ queried: 0, unresolved: 0 });
    await age(id);
    expect((await service.sweep()).queried).toBe(1);
    expect(fake.calls.ts - tsBefore).toBe(1);
    const q = fake.calls.tsBodies.at(-1);
    expect(q).toMatchObject({ CommandID: 'TransactionStatusQuery', OriginalConversationID: id, IdentifierType: 4, ResultURL: TEST_B2C_CONFIG.resultUrl });
    const queryId = await lastQuery(id);
    expect(q.OriginatorConversationID).toBe(queryId);
    // Backoff: an immediate second sweep does not query again.
    expect((await service.sweep()).queried).toBe(0);

    expect((await service.handleResult(tsResultBody(queryId, { receipt: 'TSRECEIPT1' })))?.kind).toBe('applied');
    expect(await payout(id)).toMatchObject({ status: 'PAID', receipt: 'TSRECEIPT1' });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'RELEASED' });
    expect(await carry(a.agentId)).toBe(50);
    expect(fake.calls.b2c).toBe(b2cBefore); // never resent
  });

  it('a late answer to an earlier Transaction Status query still settles the payout', async () => {
    const a = await agent();
    await escrow(a.agentId, '30.00');
    b2cHandler = () => 'timeout';
    const id = (await claim(a.token)).body.payout.payout_id;
    await age(id);
    await service.sweep();
    const first = await lastQuery(id);
    await age(id);
    await service.sweep();
    expect(await lastQuery(id)).not.toBe(first);
    expect((await payout(id)).status_query_ids).toHaveLength(2);
    expect((await service.handleResult(tsResultBody(first, { receipt: 'LATE000001' })))?.kind).toBe('applied');
    expect(await payout(id)).toMatchObject({ status: 'PAID', receipt: 'LATE000001' });
  });

  it('Transaction Status queries that were never sent (Daraja unreachable) give the attempt back: never UNRESOLVED', async () => {
    const a = await agent();
    await escrow(a.agentId, '30.00');
    b2cHandler = () => 'timeout';
    const id = (await claim(a.token)).body.payout.payout_id;
    tsHandler = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    for (let i = 0; i < 4; i++) {
      await age(id);
      expect(await service.sweep()).toEqual({ queried: 1, unresolved: 0 });
    }
    expect(await payout(id)).toMatchObject({ status: 'UNKNOWN', status_attempts: 0 });
    expect((await payout(id)).status_query_ids).toHaveLength(4);
  });

  it('a result with a contradicting ConversationID on an open payout is refused', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '30.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    expect(await service.handleResult(b2cResultBody(id, { conversationId: 'AG_FORGED', receipt: 'FORGED0001' }))).toBeNull();
    expect(await payout(id)).toMatchObject({ status: 'SENT', receipt: null });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'CLAIMED', payout_id: id });
  });

  it('a PAID result for a FAILED payout is a CONFLICT event (possible double payment); status unchanged, no extra SMS', async () => {
    const a = await agent();
    await escrow(a.agentId, '30.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    await service.handleResult(b2cResultBody(id, { code: 2001, conversationId: 'AG_PAY_1' }));
    await service.settled();
    const sms = sent.length;
    const out = await service.handleResult(b2cResultBody(id, { conversationId: 'AG_PAY_1', receipt: 'CONFL00001' }));
    expect(out).toMatchObject({ kind: 'duplicate', conflict: expect.stringMatching(/^CONFLICT: PAID B2C result for a FAILED payout \(possible double payment\)/) });
    expect(await payout(id)).toMatchObject({ status: 'FAILED', receipt: null });
    expect(await events(a.userId)).toContainEqual(expect.stringMatching(/CONFLICT: PAID B2C result for a FAILED payout \(possible double payment\)/));
    expect(logs[2].mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/SECURITY: CONFLICT/));
    await service.settled();
    expect(sent.length).toBe(sms);
    // The same (agreeing) answer again is a plain duplicate.
    expect(await service.handleResult(b2cResultBody(id, { code: 2001, conversationId: 'AG_PAY_1' }))).toEqual({ kind: 'duplicate' });
  });

  it('a PAID result without a name parameter is not a name mismatch', async () => {
    const a = await agent();
    await escrow(a.agentId, '30.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    await service.handleResult(b2cResultBody(id, { name: null, conversationId: 'AG_PAY_1', receipt: 'NONAME0001' }));
    expect(await payout(id)).toMatchObject({ status: 'PAID' });
    expect(await events(a.userId, 'PAYOUT_NAME_MISMATCH')).toEqual([]);
  });

  it('missing ConversationID on acceptance → UNKNOWN', async () => {
    const a = await agent();
    await escrow(a.agentId, '20.00');
    b2cHandler = () => ({ status: 200, body: { ResponseCode: '0', ResponseDescription: 'Accept' } });
    expect((await claim(a.token)).body.payout.status).toBe('UNKNOWN');
  });

  it('lost result: SENT → Transaction Status Failed → FAILED, escrows claimable; no definitive answer after the attempts → UNRESOLVED → payout:resolve', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '40.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    await age(id);
    await service.sweep();
    await service.handleResult(tsResultBody(await lastQuery(id), { status: 'Failed' }));
    expect(await payout(id)).toMatchObject({ status: 'FAILED', failure_reason: 'ts_failed' });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'HELD' });

    // No definitive answer: retried with backoff, then UNRESOLVED (still open: no new claim).
    const id2 = (await claim(a.token)).body.payout.payout_id;
    tsHandler = () => ({ status: 500, body: { errorCode: '500.003.1001', errorMessage: 'Internal' } });
    for (let i = 0; i < 2; i++) {
      await age(id2);
      expect((await service.sweep()).queried).toBe(1);
    }
    // A "not found" answer is evidence only (it could still have been paid).
    expect((await service.handleResult(tsResultBody(await lastQuery(id2), { code: 1 })))?.kind).toBe('pending');
    await age(id2);
    expect(await service.sweep()).toEqual({ queried: 0, unresolved: 1 });
    expect(await payout(id2)).toMatchObject({ status: 'UNRESOLVED', status_attempts: 2 });
    expect((await claim(a.token)).body).toEqual({ error: 'payout_in_progress' });
    await service.settled();
    expect(sent.at(-1)!.message).toMatch(/has not confirmed/);

    await expect(payoutResolve(service, [id, 'failed'])).rejects.toThrow(/only an UNRESOLVED payout.*FAILED/);
    expect(await payoutResolve(service, [id2, 'paid', 'qwe123rty9'])).toMatch(/is now PAID/);
    expect(await payout(id2)).toMatchObject({ status: 'PAID', receipt: 'QWE123RTY9' });
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'RELEASED' });
    expect(await events(a.userId)).toContainEqual(expect.stringMatching(/paid \(resolved by admin \S+\), receipt QWE123RTY9/));
  });

  it('refusals: below minimum, no destination, cooling-off replacement, stale disclosure, bad PIN, disabled', async () => {
    const small = await agent();
    await escrow(small.agentId, '9.99');
    await escrow(small.agentId, '100.00', { matured: false });
    expect((await claim(small.token)).body).toMatchObject({ error: 'below_minimum', amount: 9, min_amount: 10 });

    const none = await agent({ destination: 'none' });
    await escrow(none.agentId, '50.00');
    expect((await claim(none.token)).body).toEqual({ error: 'no_active_destination' });

    const cooling = await agent();
    await escrow(cooling.agentId, '50.00');
    await db.pool.query(
      `INSERT INTO payout_destinations (agent_id, msisdn, status, verified_at, cooling_off_until) VALUES ($1, '254711111111', 'COOLING_OFF', NOW(), NOW() + INTERVAL '1 day')`,
      [cooling.agentId]
    );
    expect((await claim(cooling.token)).body).toEqual({ error: 'destination_changing' });
    expect((await get(cooling.token)).body.destination_changing).toBe(true);

    const stale = await claim(cooling.token, { pin: PIN, disclosure_version: '0' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'disclosure_changed', disclosure: { version: '1' } });
    expect((await claim(cooling.token, { pin: '0000', disclosure_version: '1' })).status).toBe(401);
    await db.pool.query(`UPDATE users SET disabled_at = NOW() WHERE user_id = $1`, [cooling.userId]);
    expect((await claim(cooling.token)).status).toBe(403);
    expect(await count(db.pool, `SELECT count(*) AS n FROM payouts WHERE agent_id = ANY($1::uuid[])`, [[small.agentId, none.agentId, cooling.agentId]])).toBe(0);
  });

  it('over max: the oldest escrows up to the maximum; the rest stays claimable', async () => {
    const capped = new PayoutService({
      db: db.pool,
      b2c: new B2cClient({ ...TEST_B2C_CONFIG, timeoutMs: 300 }, fake.fn as any),
      auth: new AuthService({ db: db.pool, throttle: new LoginThrottle(new MemoryThrottleStore()) }),
      notifier: { send: async () => undefined },
      config: { maxAmount: 100 },
    });
    const a = await agent();
    const old = await escrow(a.agentId, '60.00');
    await db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - INTERVAL '3 hours' WHERE escrow_id = $1`, [old.escrowId]);
    const mid = await escrow(a.agentId, '50.00');
    await db.pool.query(`UPDATE escrow_accounts SET release_due_at = NOW() - INTERVAL '2 hours' WHERE escrow_id = $1`, [mid.escrowId]);
    const r = await capped.claim(a.userId, PIN, '1', { ip: '127.0.0.1', userAgent: undefined, deviceCookie: undefined });
    expect(r).toMatchObject({ kind: 'claimed', payout: { amount: 60 } });
    expect(await escrowRow(mid.escrowId)).toMatchObject({ escrow_status: 'HELD' });
    await capped.settled();
  });

  it('security hold mid-flight: a CLAIMED escrow is flagged and reported (CLAWBACK_DUE); on FAILED it becomes QUARANTINED and the exception is resolved', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '80.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    const held = await securityHoldReceipt(db.pool, e.receipt);
    expect(held.released).toEqual([{ escrowId: e.escrowId, amount: '1000.00' }]);
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'CLAIMED', security_hold: true });
    await db.pool.query(
      `INSERT INTO reconciliation_exceptions (kind, mpesa_receipt_id, related_receipt_id, escrow_id, amount, detail) VALUES ('CLAWBACK_DUE', $1, 'REV1', $2, 1000, 'x')`,
      [e.receipt, e.escrowId]
    );
    await service.handleResult(b2cResultBody(id, { code: 1, conversationId: 'AG_PAY_1' }));
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'QUARANTINED', security_hold: true, quarantine_reason: 'security_hold', payout_id: null });
    expect(await count(db.pool, `SELECT count(*) AS n FROM reconciliation_exceptions WHERE escrow_id = $1 AND resolved_at IS NOT NULL`, [e.escrowId])).toBe(1);
    expect((await get(a.token)).body.balance.escrows).toBe(0);
  });

  it('claim race: two concurrent claims → one 202, one 409, exactly one B2C', async () => {
    const a = await agent();
    await escrow(a.agentId, '30.00');
    await escrow(a.agentId, '30.00');
    const before = fake.calls.b2c;
    const results = await Promise.all([claim(a.token), claim(a.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'payout_in_progress' });
    expect(fake.calls.b2c - before).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM payouts WHERE agent_id = $1`, [a.agentId])).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM escrow_accounts e JOIN transactions t USING (transaction_id) WHERE t.agent_id = $1 AND e.escrow_status = 'CLAIMED'`, [a.agentId])).toBe(2);
  });

  it('PAYOUTS_ENABLED=false: the routes answer 503 and the sweep does nothing', async () => {
    const a = await agent();
    const e = await escrow(a.agentId, '30.00');
    const id = (await claim(a.token)).body.payout.payout_id;
    await age(id);
    process.env.PAYOUTS_ENABLED = 'false';
    expect((await get(a.token)).status).toBe(503);
    expect((await claim(a.token)).body).toEqual({ error: 'payouts_disabled' });
    const ts = fake.calls.ts;
    expect(await service.sweep()).toEqual({ queried: 0, unresolved: 0 });
    expect(fake.calls.ts).toBe(ts);
    expect(await escrowRow(e.escrowId)).toMatchObject({ escrow_status: 'CLAIMED' });
  });
});
