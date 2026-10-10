/**
 * @file metrics.service.ts
 * @description In-process counters reported on /health/details (spec gh-5): login outcomes,
 * STK initiation outcomes and Daraja latency. Process-local and reset on restart.
 */

const LATENCY_SAMPLES = 200;

export class GatewayMetrics {
  readonly login = { success: 0, failure: 0, throttled: 0, hardLocks: 0, unavailable: 0 };
  readonly refresh = { rotated: 0, grace: 0, reuseDetected: 0, failure: 0 };
  readonly stk: Record<'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'replayed' | 'rateLimited' | 'possibleDuplicate', number> = {
    ACCEPTED: 0,
    REJECTED: 0,
    UNKNOWN: 0,
    replayed: 0,
    rateLimited: 0,
    possibleDuplicate: 0,
  };
  readonly stkCallbacksFailed = { recorded: 0, unmatched: 0 };
  private readonly darajaLatency: number[] = [];
  globalLoginFailureAlarm = false;

  recordDarajaLatency(ms: number): void {
    this.darajaLatency.push(ms);
    if (this.darajaLatency.length > LATENCY_SAMPLES) this.darajaLatency.shift();
  }

  snapshot() {
    const sorted = [...this.darajaLatency].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : null);
    return {
      login: { ...this.login, globalFailureAlarm: this.globalLoginFailureAlarm },
      refresh: { ...this.refresh },
      stk: { ...this.stk, failedCallbacks: { ...this.stkCallbacksFailed } },
      darajaLatencyMs: { samples: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null },
    };
  }
}

export const metrics = new GatewayMetrics();
