/**
 * @file ledger.domain.test.ts
 * @description Pure ledger-sync rules (DLT-03, #10): the state preimage v1 and its HMAC (pinned
 * vector), request builders against the #9 input formats, failureCode sanitising, chaincode error
 * classification, the Fabric block-header hash (DER), and the 1000-escrow claim cap.
 */

import crypto from 'crypto';
import {
  authoriseRequest,
  blockHeaderHash,
  canonicalJson,
  chaincodeCode,
  commitRequest,
  hmacHex,
  quarantineRequest,
  releaseRequest,
  sanitizeCode,
  settleRequest,
  statePreimageV1,
  type EscrowState,
} from '../src/domain/ledger';
import { MAX_CLAIM_ESCROWS, splitClaim } from '../src/domain/payout';

const STATE: EscrowState = {
  escrowId: 'e0000000-0000-4000-8000-000000000001',
  transactionId: '70000000-0000-4000-8000-000000000001',
  agentId: 'a0000000-0000-4000-8000-000000000001',
  mpesaReceiptId: 'NLJ7RT61SV',
  rawPayloadHash: `k1:${'ab'.repeat(32)}`,
  amountCents: 100000,
  grossCents: 1505,
  verificationId: '90000000-0000-4000-8000-000000000001',
  modelVersion: 'v1.0.0',
  modelSha256: null,
  decision: 'CLEAR',
  failSafe: false,
  quarantineReason: null,
  releaseDueAt: new Date('2026-10-21T12:00:00+03:00'),
};
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

describe('canonical JSON and the state preimage v1', () => {
  it('sorts keys recursively, drops undefined, keeps array order, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: null }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":1}]},"b":1}');
  });

  it('is the documented v1 preimage (UTC ms time) and its HMAC is pinned', () => {
    const pre = statePreimageV1(STATE);
    expect(pre).toBe(
      '{"agentId":"a0000000-0000-4000-8000-000000000001","amountCents":100000,"decision":"CLEAR","escrowId":"e0000000-0000-4000-8000-000000000001",' +
        '"failSafe":false,"grossCents":1505,"modelSha256":null,"modelVersion":"v1.0.0","mpesaReceiptId":"NLJ7RT61SV","quarantineReason":null,' +
        `"rawPayloadHash":"k1:${'ab'.repeat(32)}","releaseDueAt":"2026-10-21T09:00:00.000Z","transactionId":"70000000-0000-4000-8000-000000000001",` +
        '"v":1,"verificationId":"90000000-0000-4000-8000-000000000001"}'
    );
    expect(hmacHex(Buffer.from('state-key-for-the-test-vector-0123456789'), pre)).toBe('1f0683106b9ac58c1aab0cd3faf04a685559d37794e813347f69e52d37a87159');
  });

  it('any state change changes the hash', () => {
    const k = Buffer.from('k'.repeat(32));
    const h = hmacHex(k, statePreimageV1(STATE));
    expect(hmacHex(k, statePreimageV1({ ...STATE, grossCents: 1506 }))).not.toBe(h);
    expect(hmacHex(k, statePreimageV1({ ...STATE, quarantineReason: 'fail_safe' }))).not.toBe(h);
  });
});

describe('sanitizeCode (failureCode / reasons)', () => {
  it.each([
    ['b2c_2001', 'b2c_2001'],
    ['ts_Completed.Reversed', 'ts_completed_reversed'],
    ['2001', 'x2001'],
    ['_x', 'x_x'],
    ['', 'x'],
    ['B2C-2001 timeout', 'b2c_2001_timeout'],
  ])('%j → %j', (raw, out) => {
    expect(sanitizeCode(raw)).toBe(out);
    expect(sanitizeCode(raw)).toMatch(CODE_RE);
  });
  it('cuts to 40 characters', () => {
    expect(sanitizeCode(`ledger_${'a'.repeat(60)}`)).toHaveLength(40);
  });
});

describe('request builders (#9 strict JSON)', () => {
  it('CommitTransaction: exactly the contract fields; agentRef = agent id; times in UTC ms', () => {
    const r = JSON.parse(commitRequest(STATE, 'f'.repeat(64)));
    expect(r).toEqual({
      escrowId: STATE.escrowId,
      agentRef: STATE.agentId,
      stateHash: 'f'.repeat(64),
      modelVersion: 'v1.0.0',
      modelSha256: '',
      decision: 'CLEAR',
      failSafe: false,
      quarantineReason: '',
      grossCents: 1505,
      releaseDueAt: '2026-10-21T09:00:00.000Z',
    });
  });

  it('CommitTransaction: a bad model version / digest / decision never makes the row dead; unknown decision fails closed', () => {
    const r = JSON.parse(commitRequest({ ...STATE, modelVersion: 'v1 (fail safe)', modelSha256: 'B'.repeat(64), decision: 'MAYBE', quarantineReason: 'trust_below_threshold' }, 'f'.repeat(64)));
    expect(r.modelVersion).toBe('v1__fail_safe_');
    expect(r.modelSha256).toBe('');
    expect(r.decision).toBe('QUARANTINE');
    expect(r.quarantineReason).toBe('trust_below_threshold');
    expect(JSON.parse(commitRequest({ ...STATE, modelVersion: '' }, 'f'.repeat(64))).modelVersion).toBe('unknown');
    expect(JSON.parse(commitRequest({ ...STATE, modelSha256: 'c'.repeat(64) }, 'f'.repeat(64))).modelSha256).toBe('c'.repeat(64));
  });

  it('Quarantine / Release carry their requestId', () => {
    expect(JSON.parse(quarantineRequest('r1', 'e1', 'security_hold'))).toEqual({ requestId: 'r1', escrowId: 'e1', reason: 'security_hold' });
    expect(JSON.parse(releaseRequest('r2', 'e1', 'admin_release', new Date('2026-10-21T09:00:00Z')))).toEqual({
      requestId: 'r2',
      escrowId: 'e1',
      reason: 'admin_release',
      releaseDueAt: '2026-10-21T09:00:00.000Z',
    });
  });

  it('AuthorisePayout', () => {
    const r = JSON.parse(
      authoriseRequest({
        payoutId: 'p1',
        agentId: 'a1',
        escrowIds: ['e2', 'e1'],
        grossCents: 45150,
        carryInCents: 0,
        carryOutCents: 50,
        amount: 451,
        consentDigest: 'd'.repeat(64),
        disclosureVersion: '1',
        canary: { status: 'HEALTHY', destinationRef: 'd1', checkedAt: new Date('2026-10-21T09:00:00Z') },
      })
    );
    expect(r).toEqual({
      payoutId: 'p1',
      agentRef: 'a1',
      escrowIds: ['e2', 'e1'],
      grossCents: 45150,
      carryInCents: 0,
      carryOutCents: 50,
      amount: 451,
      consentDigest: 'd'.repeat(64),
      disclosureVersion: '1',
      canary: { status: 'HEALTHY', destinationRef: 'd1', checkedAt: '2026-10-21T09:00:00.000Z' },
    });
  });

  it('SettlePayout: PAID has no FAILED fields; FAILED sanitises the code and sorts the quarantined set', () => {
    expect(JSON.parse(settleRequest('p1', { outcome: 'PAID' }))).toEqual({ payoutId: 'p1', outcome: 'PAID' });
    expect(JSON.parse(settleRequest('p1', { outcome: 'FAILED', failureCode: 'TS_Completed.X', quarantineEscrowIds: ['e2', 'e1'] }))).toEqual({
      payoutId: 'p1',
      outcome: 'FAILED',
      failureCode: 'ts_completed_x',
      quarantineEscrowIds: ['e1', 'e2'],
    });
  });
});

describe('chaincodeCode (EndorseError.details[].message)', () => {
  const endorse = (...messages: string[]) => ({ message: '10 ABORTED: failed to endorse transaction, see attached details', details: messages.map((m) => ({ address: 'peer', mspId: 'MerchantMSP', message: m })) });
  it('reads the #9 code from a detail (terminal)', () => {
    expect(chaincodeCode(endorse('chaincode response 500, LOCKED_BY_AUDITOR: escrow e1 can be released only by the auditor'))).toBe('LOCKED_BY_AUDITOR');
    expect(chaincodeCode(endorse('NOT_FOUND: payout p1'))).toBe('NOT_FOUND');
    expect(chaincodeCode(endorse('rpc error: unavailable', 'chaincode response 500, CANARY_NOT_HEALTHY: payout p1'))).toBe('CANARY_NOT_HEALTHY');
  });
  it('everything else is infrastructure (retry): no details, a gRPC status text, policy / MVCC failures', () => {
    expect(chaincodeCode(new Error('14 UNAVAILABLE: No connection established'))).toBeNull();
    expect(chaincodeCode({ message: '5 NOT_FOUND: x', details: [] })).toBeNull();
    expect(chaincodeCode(endorse('failed to collect enough transaction endorsements', 'ENDORSEMENT_POLICY_FAILURE'))).toBeNull();
    expect(chaincodeCode(endorse('MVCC_READ_CONFLICT'))).toBeNull();
    expect(chaincodeCode(endorse('UNKNOWN_CODE: x'))).toBeNull();
    expect(chaincodeCode(undefined)).toBeNull();
  });
});

describe('blockHeaderHash (DER SEQUENCE{INTEGER, OCTET STRING, OCTET STRING} + SHA-256)', () => {
  const sha = (hex: string) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
  it('genesis: number 0, empty previous hash', () => {
    const data = '01'.repeat(32);
    expect(blockHeaderHash(0n, new Uint8Array(), Buffer.from(data, 'hex'))).toBe(sha(`3027020100` + `0400` + `0420${data}`));
  });
  it('a number with its top bit set gets a leading zero byte; multi-byte numbers are big-endian', () => {
    const p = 'aa'.repeat(32);
    const d = 'bb'.repeat(32);
    expect(blockHeaderHash(128n, Buffer.from(p, 'hex'), Buffer.from(d, 'hex'))).toBe(sha(`3048` + `02020080` + `0420${p}` + `0420${d}`));
    expect(blockHeaderHash(300n, Buffer.from(p, 'hex'), Buffer.from(d, 'hex'))).toBe(sha(`3048` + `0202012c` + `0420${p}` + `0420${d}`));
  });
  it('long-form lengths above 127 bytes', () => {
    const p = 'cc'.repeat(200);
    expect(blockHeaderHash(1n, Buffer.from(p, 'hex'), new Uint8Array())).toBe(sha(`3081d0` + `020101` + `0481c8${p}` + `0400`));
  });
});

describe('splitClaim cap (AuthorisePayout takes at most 1000 escrows)', () => {
  it('stops at 1000 escrows; the rest stays claimable', () => {
    const escrows = Array.from({ length: 1500 }, (_, i) => ({ escrowId: `e${i}`, cents: 100 }));
    const s = splitClaim(escrows, 0, 150_000);
    expect(MAX_CLAIM_ESCROWS).toBe(1000);
    expect(s.escrowIds).toHaveLength(1000);
    expect(s).toMatchObject({ grossCents: 100_000, amount: 1000, carryOutCents: 0 });
  });
});
