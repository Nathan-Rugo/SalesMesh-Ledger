/**
 * @file canary.service.ts
 * @description The payout preflight attestation AuthorisePayout requires (#9 "Canary = payout
 * preflight"). A KES 1 canary cannot see Fuliza, and the agent decides about their own Fuliza debt
 * through the disclosure, so the attestation is: HEALTHY iff the payout's destination is ACTIVE and
 * the agent's consent is recorded on the payout. `destinationRef` is the destination's UUID (no MSISDN).
 */

import type { Db } from '../repositories/db.types';
import type { Canary } from '../domain/ledger';

export async function payoutCanary(db: Db, payoutId: string, now: Date = new Date()): Promise<Canary> {
  const { rows: [r] } = await db.query(
    `SELECT p.destination_id, d.status, p.consent_hash FROM payouts p JOIN payout_destinations d USING (destination_id) WHERE p.payout_id = $1`,
    [payoutId]
  );
  if (!r) throw new Error(`payout ${payoutId} not found`);
  const healthy = r.status === 'ACTIVE' && /^[0-9a-f]{64}$/.test(r.consent_hash ?? '');
  return { status: healthy ? 'HEALTHY' : 'UNHEALTHY', destinationRef: r.destination_id, checkedAt: now };
}
