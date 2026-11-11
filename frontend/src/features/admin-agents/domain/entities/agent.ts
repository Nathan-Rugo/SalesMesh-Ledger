/** The payout destination an agent is paid to; the number is masked by the gateway. */
export interface AgentPayout {
  readonly status: string;
  readonly msisdn: string;
}

/** One sales agent on the merchant account (admin directory, read-only). */
export interface DirectoryAgent {
  readonly agentCode: string | null;
  readonly name: string;
  /** Masked by the gateway; the raw number never reaches the client. */
  readonly msisdn: string;
  /** The agent has replaced the one-time PIN with their own. */
  readonly activated: boolean;
  readonly disabled: boolean;
  readonly payout: AgentPayout | null;
}
