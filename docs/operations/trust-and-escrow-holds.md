# Trust scores and risk-adaptive escrow holds

Spec gh-23 (issue #23) implements thesis Messages 7, 8 and 14 and Data Dictionary Tables 4 (`SALES_AGENTS.agent_trust_rating`) and 7 (`TRUST_SCORES`).

## How a hold is computed

When a model-scored payment settles (or a fail-safe quarantine is re-scored), the gateway computes:

```
p_eff   = layer-2 adjudicated ? calibrated XGBoost p : ½·review_p·(s / fast_clear_s)   (proxy, < 0.25)
S_t     = (1 − p_eff)^w · R_eff^(1 − w)                                                w = 0.7
T_hold  = min(T_max, (T_min + (T_max − T_min)·(1 − S_t)^γ) · max(1, m)^κ)            1 h … 72 h
m       = amount / agent's 30-day median of cleanly settled payments (reference KES 1,000 when < 5)
freeze  = model CLEAR with S_t ≤ (1 − review_p)^w ≈ 0.6156  →  QUARANTINED (trust_below_threshold)
```

Every model-scored verification writes a `trust_scores` row with all inputs, the result, the dominant term (`hold_reason`) and a `config_hash` that points at the exact parameters in `trust_config_snapshots`. That makes every hold recomputable.

## How an agent's rating moves

The rating changes only on evidence, never on the ML score:

| Event | Change | Limit |
|---|---|---|
| A hold matures with no security event (`HOLD_MATURED_CLEAN`) | `R ← R + 0.05·(1 − R)` | once per receipt; ≤ 10 per agent per day |
| A receipt is confirmed on an imported M-Pesa statement (`STATEMENT_CONFIRMED`) | same | once per receipt; exempt from the daily cap |
| A security event of a hold type (reversal, payload mutation, attribution conflict, amount mismatch, not-on-statement) | `R ← max(0, R − 0.15)` | once per (event type, receipt) |

Rules for new agents:

- New agents start at **0.5**. This deliberately deviates from the data dictionary default of 1.000, so that a brand-new agent does not get the fastest holds.
- Ratings are capped at **0.85** until the agent has 20 clean matured holds over 7 distinct days and at least KES 10,000 settled.

Every change is audited in `agent_trust_events`, which is idempotent through UNIQUE(`cause`, `ref`).

## Operator tasks

- **Undo an unfair penalty** (for example a not-on-statement alarm caused by clock skew):
  ```
  npm run trust:adjust -- --agent <agent_id> --delta 0.15 --reason "clock-skew false alarm" --ref <ticket-id>
  ```
  The change is recorded as `OPERATOR_ADJUST` with `ref = operator:<agent_id>:<ticket-id>`. Re-running it with the same ticket id has no further effect.
- **Find stuck work:** `/health/details` reports two things under `trust`. `frozenAgents` counts agents whose rating is so low that even a p = 0 payment is frozen; they need review. `quarantinedByReason` breaks quarantines down by reason. Trust-based quarantines (`trust_below_threshold`, `trust_input_invalid`) are model decisions, so self-heal never re-scores them; they appear as stalled quarantines for operator action.
- **Tune parameters:** all `TRUST_*` variables are listed in `.env.example`. Startup refuses invalid or self-contradictory settings, for example a freeze threshold that no new agent could ever pass. Each new parameter set is recorded as a `trust_config_snapshots` row.

## Frozen-payout queue and SLA

Frozen commission waits for an admin: a QUARANTINED escrow (model decision, stalled fail-safe, trust freeze or security hold, UFAA-frozen included) or an UNRESOLVED payout.

- **The queue:** `GET /api/v1/admin/frozen-payouts` (MERCHANT_ADMIN token) lists every frozen item, overdue first, then oldest first. Each list is capped at 200 and `totals` gives the full counts. Phones are masked. It is read-only: release, reject and override belong to the risk-oversight queue (#14). An UNRESOLVED payout is still settled with `npm run payout:resolve`, which takes it off the list.
- **The clock:** an escrow's `frozen_at` is set by a database trigger whenever it enters QUARANTINED, and it is cleared when the escrow leaves. A later re-quarantine starts a new spell. A payout's `unresolved_at` is set when it becomes UNRESOLVED.
- **The SLA:** 72 h for an escrow (`FROZEN_ESCROW_SLA_HOURS`) and 24 h for a payout (`UNRESOLVED_PAYOUT_SLA_HOURS`). Each housekeeping sweep (at most hourly, only inside `PAYOUT_REMINDER_HOURS`, 08:00–20:00 Nairobi) marks each overdue spell once (`sla_escalated_at`). It sends every active MERCHANT_ADMIN one SMS digest with counts and KES totals only. A breach at night escalates at the next daytime sweep. With no active admin the items are still marked and a WARN is logged. The sweep runs even with `PAYOUTS_ENABLED=false`. `/health/details` reports `frozenSla` (escalated, alertsSent, alertsFailed).

## Deployment

Migration `009_frozen_sla_escalation.sql` adds the freeze clocks and the trigger. It backfills `frozen_at` from the latest verification time (or the migration time) and `unresolved_at` from the payout's last update. It alters `escrow_accounts` and `payouts`, backfills them and builds the indexes in one transaction, so it holds table locks until COMMIT. Like 003 and 004, run it in a quiet window.

Migration `004_trust_scores.sql` is required. It resets existing agents to 0.5 (no history credit), backfills `quarantine_reason`, and aborts with a list of IDs if legacy data has duplicate trust rows. Like 003, it takes ACCESS EXCLUSIVE locks until COMMIT, so run it in a maintenance window.
