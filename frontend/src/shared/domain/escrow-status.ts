/** Escrow lifecycle states the gateway reports, with their Design_Inspo semantic tone. */
export const ESCROW_STATUSES = ['CLEAR', 'RELEASED', 'ESCROW_HOLD', 'QUARANTINED', 'CANARY_VERIFYING', 'REMITTED'] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export type EscrowTone = 'clear' | 'hold' | 'quarantined' | 'canary' | 'remitted';

export const isEscrowStatus = (v: unknown): v is EscrowStatus =>
  typeof v === 'string' && (ESCROW_STATUSES as readonly string[]).includes(v);

export function escrowTone(status: EscrowStatus): EscrowTone {
  switch (status) {
    case 'CLEAR':
    case 'RELEASED':
      return 'clear';
    case 'ESCROW_HOLD':
      return 'hold';
    case 'QUARANTINED':
      return 'quarantined';
    case 'CANARY_VERIFYING':
      return 'canary';
    case 'REMITTED':
      return 'remitted';
  }
}

export function escrowLabel(status: EscrowStatus): string {
  switch (status) {
    case 'CLEAR':
      return 'Clear';
    case 'RELEASED':
      return 'Released';
    case 'ESCROW_HOLD':
      return 'In escrow';
    case 'QUARANTINED':
      return 'Quarantined';
    case 'CANARY_VERIFYING':
      return 'Verifying';
    case 'REMITTED':
      return 'Remitted (UFAA)';
  }
}

/** Escrow states as the gateway stores them (escrow_accounts.escrow_status). */
export type GatewayEscrowStatus = 'HELD' | 'CLAIMED' | 'QUARANTINED' | 'RELEASED' | 'REMITTED';

/**
 * Gateway state → lifecycle state. `matured` is the server snapshot's view (release_due_at passed);
 * a security hold quarantines whatever the stored state is.
 */
export function fromGatewayEscrow(status: GatewayEscrowStatus, o: { matured: boolean; securityHold: boolean }): EscrowStatus {
  if (o.securityHold || status === 'QUARANTINED') return 'QUARANTINED';
  switch (status) {
    case 'HELD':
      return o.matured ? 'CLEAR' : 'ESCROW_HOLD';
    case 'CLAIMED':
      return 'CLEAR';
    case 'RELEASED':
      return 'RELEASED';
    case 'REMITTED':
      return 'REMITTED';
  }
}
