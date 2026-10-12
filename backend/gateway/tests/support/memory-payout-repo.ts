/**
 * In-memory stand-in for src/repositories/payout_destination.repository (unit tests), with the same
 * exported signatures and state machine. The partial unique indexes are emulated in claim; JS is
 * single-threaded, so each function is atomic like its SQL transaction. `memPayout.advance(ms)`
 * moves NOW() for the sweeps. The real SQL runs in tests/integration/payout.int.test.ts.
 */

import crypto from 'crypto';
import type { B2cOutcome, B2cResult } from '../../src/daraja/client';
import { maskMsisdn, namesMatch } from '../../src/domain/payout_destination';
import type {
  ApplyOutcome,
  CancelOutcome,
  DestinationChange,
  DestinationEvent,
  DestinationRow,
} from '../../src/repositories/payout_destination.repository';

export const memPayout = {
  rows: [] as DestinationRow[],
  events: [] as Array<{ userId: string | null; detail: string; at: Date }>,
  /** agent_id → its user and users.full_name */
  agents: new Map<string, { userId: string; fullName: string }>(),
  offsetMs: 0,
  now() {
    return new Date(Date.now() + this.offsetMs);
  },
  advance(ms: number) {
    this.offsetMs += ms;
  },
  reset() {
    this.rows.length = 0;
    this.events.length = 0;
    this.agents.clear();
    this.offsetMs = 0;
  },
};

const OPEN = ['ACTIVE', 'PENDING_VERIFICATION', 'COOLING_OFF'];
const copy = (d: DestinationRow): DestinationRow => ({ ...d });
const userOf = (agentId: string) => memPayout.agents.get(agentId)?.userId ?? null;
const event = (userId: string | null, d: DestinationRow, what: string) =>
  memPayout.events.push({ userId, detail: eventDetail(d, what), at: memPayout.now() });

// Same text as the real eventDetail (the real module is the one this file replaces under jest.mock).
export const eventDetail = (d: Pick<DestinationRow, 'destinationId' | 'msisdn'>, what: string): string =>
  `destination ${d.destinationId} (${maskMsisdn(d.msisdn)}): ${what}`;

export async function findOpenDestinations(_db: unknown, agentId: string): Promise<DestinationRow[]> {
  return memPayout.rows.filter((r) => r.agentId === agentId && OPEN.includes(r.status)).map(copy);
}

export async function claimDestination(_db: unknown, c: { agentId: string; userId: string; msisdn: string }): Promise<DestinationRow | null> {
  if (memPayout.rows.some((r) => r.agentId === c.agentId && (r.status === 'PENDING_VERIFICATION' || r.status === 'COOLING_OFF'))) return null;
  const now = memPayout.now();
  const d: DestinationRow = {
    destinationId: crypto.randomUUID(),
    agentId: c.agentId,
    msisdn: c.msisdn,
    status: 'PENDING_VERIFICATION',
    rejectReason: null,
    conversationId: null,
    resultCode: null,
    sentAt: now,
    verifiedAt: null,
    coolingOffUntil: null,
    createdAt: now,
  };
  memPayout.rows.push(d);
  event(c.userId, d, 'registered; verification payment requested');
  return copy(d);
}

export async function recordB2cOutcome(_db: unknown, id: string, userId: string, outcome: B2cOutcome): Promise<DestinationRow | null> {
  const d = memPayout.rows.find((r) => r.destinationId === id);
  if (!d) return null;
  if (outcome.kind === 'ACCEPTED') {
    d.conversationId = d.conversationId ?? outcome.conversationId;
    return copy(d);
  }
  if (outcome.kind === 'UNKNOWN' || d.status !== 'PENDING_VERIFICATION') return null;
  Object.assign(d, { status: 'REJECTED', rejectReason: `b2c_${outcome.code}`.slice(0, 40), resultCode: outcome.code.slice(0, 20) });
  event(userId, d, `rejected (${d.rejectReason})`);
  return copy(d);
}

export async function applyVerificationResult(_db: unknown, result: B2cResult, coolingOffMs: number): Promise<ApplyOutcome> {
  const d = memPayout.rows.find((r) => r.destinationId === result.originatorConversationId);
  if (!d) return { kind: 'unknown' };
  if (d.status === 'EXPIRED') {
    if (d.resultCode !== null) return { kind: 'duplicate' };
    d.resultCode = result.resultCode;
    d.conversationId = d.conversationId ?? result.conversationId;
    event(userOf(d.agentId), d, `late B2C result after expiry, ResultCode ${result.resultCode}`);
    return { kind: 'late' };
  }
  if (d.status !== 'PENDING_VERIFICATION') return { kind: 'duplicate' };
  if (d.conversationId && result.conversationId && d.conversationId !== result.conversationId) return { kind: 'unknown' };
  const agent = memPayout.agents.get(d.agentId)!;
  d.resultCode = result.resultCode;
  d.conversationId = d.conversationId ?? result.conversationId;
  let what: string;
  if (result.resultCode !== '0' || !namesMatch(result.receiverName, agent.fullName)) {
    d.status = 'REJECTED';
    d.rejectReason = result.resultCode !== '0' ? `b2c_${result.resultCode}`.slice(0, 40) : 'name_mismatch';
    what = `rejected (${d.rejectReason})`;
  } else {
    d.verifiedAt = memPayout.now();
    if (memPayout.rows.some((r) => r.agentId === d.agentId && r.status === 'ACTIVE')) {
      d.status = 'COOLING_OFF';
      d.coolingOffUntil = new Date(memPayout.now().getTime() + coolingOffMs);
      what = `verified; replacement cooling off until ${d.coolingOffUntil.toISOString()}`;
    } else {
      d.status = 'ACTIVE';
      what = 'verified; active';
    }
  }
  event(agent.userId, d, what);
  return { kind: 'applied', destination: copy(d), userId: agent.userId };
}

export async function promoteDue(_db: unknown, limit = 100): Promise<DestinationChange[]> {
  const now = memPayout.now().getTime();
  const due = memPayout.rows.filter((r) => r.status === 'COOLING_OFF' && r.coolingOffUntil!.getTime() <= now).slice(0, limit);
  const changes: DestinationChange[] = [];
  for (const d of due) {
    let superseded: DestinationRow | null = null;
    for (const old of memPayout.rows.filter((r) => r.agentId === d.agentId && r.status === 'ACTIVE')) {
      old.status = 'SUPERSEDED';
      superseded = copy(old);
      event(userOf(old.agentId), old, 'superseded by a replacement');
    }
    d.status = 'ACTIVE';
    event(userOf(d.agentId), d, 'cooling-off ended; active');
    changes.push({ destination: copy(d), userId: userOf(d.agentId), superseded });
  }
  return changes;
}

export async function expireStale(_db: unknown, olderThanMs: number, limit = 100): Promise<DestinationChange[]> {
  const cutoff = memPayout.now().getTime() - olderThanMs;
  const stale = memPayout.rows.filter((r) => r.status === 'PENDING_VERIFICATION' && r.sentAt.getTime() < cutoff).slice(0, limit);
  return stale.map((d) => {
    d.status = 'EXPIRED';
    d.rejectReason = 'no_result';
    event(userOf(d.agentId), d, 'expired (no B2C result)');
    return { destination: copy(d), userId: userOf(d.agentId) };
  });
}

export async function cancelCoolingOff(_db: unknown, id: string, by: { agentId: string } | { admin: true }): Promise<CancelOutcome> {
  const agentId = 'agentId' in by ? by.agentId : null;
  const d = memPayout.rows.find((r) => r.destinationId === id && (agentId === null || r.agentId === agentId));
  if (!d) return { kind: 'not_found' };
  if (d.status !== 'COOLING_OFF') return { kind: 'not_cancellable' };
  d.status = 'CANCELLED';
  d.rejectReason = agentId ? 'cancelled_by_agent' : 'cancelled_by_admin';
  event(userOf(d.agentId), d, `cancelled by ${agentId ? 'the agent' : 'admin'} during cooling-off`);
  return { kind: 'cancelled', destination: copy(d) };
}

export async function listDestinations(_db: unknown, agentId: string, limit = 20): Promise<DestinationRow[]> {
  return memPayout.rows
    .filter((r) => r.agentId === agentId)
    .reverse()
    .slice(0, limit)
    .map(copy);
}

export async function listDestinationEvents(_db: unknown, userId: string, limit = 20): Promise<DestinationEvent[]> {
  return memPayout.events
    .filter((e) => e.userId === userId)
    .reverse()
    .slice(0, limit)
    .map((e) => ({ detail: e.detail, detectedAt: e.at }));
}
