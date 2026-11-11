# Stress and chaos suite (gh-15, QA-01)

Objective (v) (Sections 3.2.4, 4.2.2) says the gateway holds up under 200 webhooks/s, duplicate callbacks, commission stuffing and Fuliza intercepts. This suite measures those claims and doesn't just assume them.

## Two tiers

| Tier | Where | What | Runs in |
|---|---|---|---|
| 1 | `backend/gateway/tests/integration/resilience/` | Duplicate injection over HTTP, chaos through an in-process TCP fault proxy, the Fuliza payout check | `npm test` in CI (real Postgres + Redis services), and `npm run test:resilience` |
| 2 | `backend/gateway/tests/load/` | Open-model 200 req/s load, end-to-end stuffing detection against the real ml-engine | CLI, by hand, against a running stack |

Tier 1 drives the real `POST /api/v1/mpesa/callback/:token` router on its own express app. It uses the gateway's own `hotPool` and Redis client, both pointed at fault proxies, plus the real `SettlementWorker` and `RescoreWorker`. Each file gets its own throwaway database. Receipts carry a random per-run prefix, because Redis (db 0, 24 h key TTL) is shared across runs and parallel test files. Tier 1 skips when `TEST_DATABASE_URL` / `TEST_REDIS_URL` are unset, like the other integration tests.

The Fabric peer-outage case lives in `tests/e2e/ledger.e2e.test.ts` and isn't repeated here.

## Thresholds and where they come from

| Threshold | Source |
|---|---|
| p95 ingestion latency ≤ 200 ms | NFR-01 (sub-200 ms ingestion) |
| Hot-path deadline 150 ms (claim + intake insert), else 503 | NFR-01, `src/config/db.ts` `HOT_PATH_TIMEOUT_MS`. The chaos suite runs at this production value, not the 1.5 s test default |
| Exactly one intake row, transaction and escrow per receipt | FR-02 (atomic deduplication) |
| Never a 200 without a durable row | UC-01 / `webhook.controller.ts` |
| Anything not model-CLEARed is QUARANTINED | NFR-08 (fail-safe circuit breaker) |
| Stuffing event recall: exact 95% CI lower bound ≥ 0.90 | Spec gh-15. Offline baseline: 84/84 events, CI-low 0.957 (`ml-engine/reports/metrics.json`) |

Rates are reported with k, n and an exact Clopper–Pearson 95% interval (`tests/support/stats.ts`, checked against scipy in `stats.test.ts`). Percentiles use linear interpolation (numpy's default).

## Tier 1: what each test proves

| Scenario | Test | Expected |
|---|---|---|
| Exact replay storm: 50 receipts × 5 identical concurrent deliveries | `duplicates` | All 200; 1 intake row, 1 transaction, 1 escrow per receipt; no security events |
| C2B confirmation before the STK callback, same receipt and amount | `duplicates` | One settlement, one `STK_CHANNEL_ECHO`, escrow HELD |
| Mutated retry (same receipt, different amount) | `duplicates` | Original amount kept; `PAYLOAD_MUTATION`; escrow QUARANTINED with security hold |
| Redis cut (sockets reset) | `chaos` | Still 200 through Postgres (claim `unverified`); redelivery during and after the cut adds no row |
| Postgres cut | `chaos` | 503 and spooled; Daraja-style retry after restore → 200; spool drain + retry → exactly once |
| Postgres latency 3 × the 150 ms deadline | `chaos` | 503 while slow (no 200 without a row); a 503'd insert may commit late; retry → exactly once |
| Flaky Postgres (every 2nd new connection reset) | `chaos` | Some 503s; every receipt ACKed after redelivery; exactly once |
| ml-engine cut mid-run | `chaos` | Rows scored before the cut stay HELD; the rest are fail-safe QUARANTINED (`service_unavailable`, then `circuit_open`); after restore, the re-score promotes each one exactly once |
| Fuliza-indebted payout line | `fuliza` | See below |

### Fuliza

Safaricom deducts an outstanding Fuliza balance on the recipient's side after the B2C completes. The payer can't see it (`docs/architecture/commission-chaincode.md`, "Canary = payout preflight"), so **the intercept itself can't be observed**, and the suite doesn't fake a reduced-amount stub. For an indebted line it proves what the gateway owns:

- A claim with no consent, or consent to a superseded disclosure version, gets 409 `disclosure_changed`. No B2C is sent and no payout row is written.
- With consent to the current version, the stored `consent_hash` equals `consentHash(...)` of the accepted disclosure.
- Exactly one B2C of the full `floor(balance)` is sent and settles PAID. A duplicate result, a Transaction Status sweep and a repeat claim (`below_minimum`) never resend it or top it up.

## Tier 2: how to run

Both scripts use Node built-ins plus the existing `pg` and `tsx`. Every run writes `backend/gateway/tests/load/results/<kind>-<timestamp>.json` (git-ignored). It records the config, the environment (Node, OS, CPU model and cores, total and free RAM) and every metric. Exit codes: **0 PASS, 1 FAIL (threshold miss), 2 ABORT (a dependency was unreachable)**.

```sh
cd backend/gateway
# Load: constant arrival (open model), latency measured from each request's intended send time.
MPESA_CALLBACK_TOKEN=... DATABASE_URL=postgres://... \
  npm run load:webhooks -- --rate 200 --duration 60 --warmup 10 --base-url http://localhost:4000

# Stuffing e2e: seeds agents, sends benign background then stuffing bursts, reads verification_events.
MPESA_CALLBACK_TOKEN=... DATABASE_URL=postgres://... \
  npm run load:stuffing -- --events 120 --agents 24 --base-url http://localhost:4000 --ml-url http://localhost:8000
```

`infra/docker-compose.yml` publishes only Caddy, so the gateway (:4000), ml-engine (:8000) and Postgres aren't reachable from the host as written. Run tier 2 against an environment where they are, for example with a local compose override that publishes those ports, or from the EC2 host. Don't run the stuffing script against a database with real agents: it seeds its own `SE<run>` agents.

**Load generator.** Request *i* is due at t0 + *i*/rate, whatever the earlier requests are doing. Latency is measured from that intended time, so a stalled gateway can't hide its queueing (no coordinated omission). The JSON also reports service time and generator lag separately. PASS requires all of:

- p95 ≤ 200 ms
- 0 non-2xx (timeouts count)
- 0 ACKed receipts missing from `mpesa_callbacks` (when `DATABASE_URL` is set)
- an achieved rate of at least 95% of the target

With `DATABASE_URL` set, the script seeds the `--agent-code` agent first (idempotently), so rows settle on the known-agent path. It then checks every *sent* receipt: "lost" means ACKed with no row, and rows for non-ACKed sends are reported separately. Without `DATABASE_URL` the agent isn't seeded and the worker parks rows UNRESOLVED after the ACK. The measured hot path is the same either way, and the JSON's `config.agent_path` records which path ran.

**Stuffing e2e.** This is a TypeScript port of `ml-engine/engine/fraud_injector.py`:

- θ = 5000; the anchor A (log-normal, median 1500, σ 0.9, as in `base_traffic.py`) is drawn in (θ, 6.79θ].
- k ~ U{max(3, ⌈A/0.97θ⌉)..7}.
- The Dirichlet-escalated splits sum exactly to A, with 100 ≤ a_j < 0.98θ.
- All splits share the same agent and payer and fall within 20 minutes, with backdated `TransTime`.

An event counts as detected when any split got a non-CLEAR INITIAL decision, the same rule as `eval.py` `event_table`. Benign FPR is reported only. If any row was scored fail-safe, the gateway couldn't reach ml-engine, and the run ABORTs instead of passing.

## Measured results

| Run | Environment | Result |
|---|---|---|
| Tier 1, CI | GitHub Actions, Postgres 16 + Redis 7 services | PASS: `test` job green on PR #66 ([run 42987709489](https://github.com/Nathan-Rugo/SalesMesh-Ledger/actions/runs/42987709489)) |
| Tier 1, local (2026-11-11) | Ryzen 5 5625U, 12 threads, 7.35 GB RAM, Node 24, Docker Postgres 16 + Redis 7 | PASS: duplicates 3/3 (twice in a row), chaos 5/5, fuliza 1/1, `stats.test.ts` 14/14. Full gateway suite 711 passed, 2 skipped (ledger e2e needs Fabric) |
| Load 200 req/s, 60 s, local compose | Pending | Record it honestly even if it falls below 200/s |
| Load 200 req/s, 60 s, EC2 (pass of record) | Pending, after the AWS runbook | — |
| Stuffing e2e (≥100 events) | Pending, needs the ml-engine reachable | Compare against the offline 84/84 (CI-low 0.957) |
| Tier 2 smoke | Local, targets unreachable | Both scripts ABORT with exit 2 and write their JSON, as required. The load script against a local 200-OK stub at 100/s reached 99.7/s, PASS |

## Defects found

No gateway defects so far. Any defect a test exposes gets fixed in scope and recorded here as test → defect → fix.

Harness defects (test code, not the gateway):

| Test | Defect | Fix |
|---|---|---|
| Replay storm (`duplicates.int.test.ts`) | 250 simultaneous connects overflowed the Windows listen backlog, so requests failed with `ECONNREFUSED` before reaching the gateway | At most 25 requests in flight. The 5 copies of each receipt are adjacent, so they still race each other |
| Fault proxy under `latency()` | `close` destroyed the peer while delayed chunks were pending, so latency turned into truncated replies | The destroy is delayed by the same `delayMs` as `end` |
| Flaky Postgres (`dropEvery`) | A socket reset by the proxy surfaced as transport status 0 and failed the test, although the gateway behaved | 0 is treated like a 503: Daraja retries both |
| Chaos suite, first test (`chaos.int.test.ts`) | On a loaded machine, cold hot-pool connects (SCRAM auth through the proxy) took longer than the 150 ms deadline, so deliveries got 503 before any fault was injected | `beforeAll` warms the hot pool, retrying until 10 idle connections exist |
