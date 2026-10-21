# Gateway ↔ Fabric ledger sync (DLT-03, #10)

The gateway writes every escrow decision, fraud lock and payout to the [commission chaincode](commission-chaincode.md) on the [Fabric testnet](fabric-testnet.md). This gives each one a tamper-evident trail (FR-07). A payout is paid only after the ledger has authorised it (NFR-09). Postgres stays the system of record. The ledger is the audit trail and the payout gate.

- **Client:** `backend/gateway/src/services/fabric.service.ts`. It uses `@hyperledger/fabric-gateway` over gRPC with mTLS to `peer0.merchant`, signing as `gateway@merchant` (X.509, `role=gateway`). The peer's Gateway service collects the auditor's endorsement through discovery.
- **Outbox:** the `ledger_outbox` table, `src/repositories/ledger.repository.ts` and `src/workers/ledger.worker.ts`.
- **Gate:** `PayoutService.claim` (`src/services/payout.service.ts`) runs `AuthorisePayout` synchronously, between the claim and the B2C call.
- **Pure rules:** `src/domain/ledger.ts` holds the preimages, request builders, error classification and block hash.
- **Tests:**
  - `tests/ledger.domain.test.ts`
  - `tests/integration/ledger_sync.int.test.ts` (real Postgres, fake Fabric)
  - `make fabric-ledger-e2e`, which runs the real testnet through `tests/e2e/ledger.e2e.test.ts`

## Flow

```mermaid
sequenceDiagram
  autonumber
  participant W as Settlement / rescore / admin / security hold
  participant PG as Postgres
  participant LW as Ledger worker
  participant A as Agent (claim)
  participant PS as PayoutService
  participant F as Fabric (merchant + auditor peers)
  participant B as Daraja B2C

  W->>PG: state change + ledger_outbox row (one transaction)
  loop every LEDGER_WORKER_INTERVAL_MS
    LW->>PG: lease due rows (no earlier PENDING/DEAD row shares a key)
    LW->>F: submit the stored request (Commit / Quarantine / Release / Settle)
    alt committed
      LW->>PG: DELIVERED + tx id + block number (COMMIT: on the escrow too)
    else #9 code
      LW->>PG: DEAD (keys stay blocked), or SUPERSEDED + auditor_hold on LOCKED_BY_AUDITOR
    else infrastructure
      LW->>PG: retry with exponential backoff
    end
    LW->>F: qscc GetBlockByNumber → block hash → PG
  end
  A->>PS: POST /payouts/claim
  PS->>PG: createPayout (escrows on the ledger, matured 5 min ago) → SENT, escrows CLAIMED
  PS->>F: AuthorisePayout (retried ≤ FABRIC_AUTHORISE_TIMEOUT_MS; every tx id stored first)
  alt committed
    PS->>PG: payout ledger tx id / block
    PS->>B: BusinessPayment
    B-->>PS: result → PAID / FAILED → SETTLE row (p: + every e:)
  else refused (#9 code)
    PS->>F: GetEscrow for every claim escrow
    PS->>PG: rollback FAILED; mirror QUARANTINED ones as auditor_hold
    PS-->>A: 409 balance_under_review if any were mirrored (ledger_auditor_hold), else 503 temporarily_unavailable (ledger_<code>); no B2C, no SMS
  else still failing
    PS->>PG: rollback FAILED ledger_unavailable + Settle FAILED (delayed 5 min, tx ids to check)
    PS-->>A: 503 temporarily_unavailable
  end
```

## What goes on chain, and when

| Gateway event | Outbox row | Request |
|---|---|---|
| Escrow settled (`processSettlement`) | `COMMIT`, key `e:<escrowId>` | `CommitTransaction`. The status is derived by the chaincode from `quarantineReason` / `failSafe` / `decision`. |
| Rescore: CLEAR promote | `RELEASE` | `ReleaseEscrow` with reason `rescore_clear` and the new `releaseDueAt` |
| Rescore: new model reason | `QUARANTINE` | `QuarantineEscrow` with that reason (the owner changes the reason). Only when the reason changed. |
| Admin release (gh-14) | `RELEASE` | reason `admin_release`, due = max(original, now) |
| Security hold on a HELD / QUARANTINED escrow | `QUARANTINE` | reason `security_hold`. A CLAIMED escrow gets no row: it goes in its payout's Settle `quarantineEscrowIds`. |
| Claim | none (synchronous) | `AuthorisePayout`, with canary = HEALTHY iff the destination is ACTIVE and consent is recorded (`canary.service.ts`) |
| PAID / FAILED / admin resolve of an **authorised** payout | `SETTLE`, keys `p:<payoutId>` + every `e:` | `SettlePayout`. FAILED lists the security-held escrows. |
| Claim rolled back after an infrastructure failure | `SETTLE` FAILED, delayed 5 min, `absent_tx_ids` | sent in case the Authorise committed late (see below) |
| UFAA remit (HELD → REMITTED) | none | REMITTED is deferred in #9 |

- **Snapshots:** the request JSON is built when the row is written, in the same transaction as the state change, and stored in `ledger_outbox.request`. The worker sends exactly that text and never rebuilds it.
- **Request ids:** Quarantine and Release store their `requestId` on the row, so every retry is the same request. The chaincode's idempotency makes retries safe.
- **Ordering:** delivery is ordered per key. A row is leased only when no earlier `PENDING` or `DEAD` row shares a key. SETTLE carries every `e:` key of its payout, so an escrow returned by a FAILED payout cannot be claimed again until the ledger has it back as HELD.
- **Error classification:** a chaincode refusal is read as `CODE: detail` from `EndorseError.details[].message`.
  - The nine #9 codes are terminal: the row goes `DEAD`, is logged, counted in `/health/details` (`ledgerOutbox.dead`), and keeps blocking its keys.
  - Everything else is retried with backoff (`LEDGER_BACKOFF_BASE_MS` doubling up to `LEDGER_BACKOFF_MAX_MS`). That covers unavailable, deadline, MVCC, `ENDORSEMENT_POLICY_FAILURE` and commit failures.
  - Once the cause is fixed, `npm run ledger:requeue -- <outbox_id>` re-arms a DEAD row.
- **Stored per escrow / payout:** the tx id this gateway submitted and saw commit, its block number, and the block hash. The hash is filled by the worker from qscc `GetBlockByNumber`. The same columns are kept on every outbox row.

## Fail-safe rules (user decisions, 2026-10-21)

**Ledger down at claim → fail closed.**
- The gate retries `AuthorisePayout` (the same JSON) for up to `FABRIC_AUTHORISE_TIMEOUT_MS` (10 s). If it still fails, the claim is rolled back with `finish()`'s FAILED semantics:
  - the payout becomes FAILED `ledger_unavailable`;
  - the escrows go back to HELD, or QUARANTINED when security-held;
  - there is no B2C call and no SMS;
  - the agent gets the existing 503 `temporarily_unavailable`.
- Every Authorise tx id that may have reached the orderer is stored in `payouts.ledger_authorise_tx_ids` before it is sent.
- A Settle FAILED is queued with those ids. It is not delivered until 5 min after the rollback.
- If the Settle gets `NOT_FOUND`, it counts as done only when qscc `GetTransactionByID` finds none of those ids VALID. Otherwise the Authorise committed late, and the Settle is retried until it applies.
- If no Authorise was ever endorsed, no tx id exists and no Settle is queued.
- A security-held escrow in the rolled-back claim gets a `QUARANTINE security_hold` row after the Settle row.

**Auditor hold → mirror on refusal.**
- When Authorise is refused (any #9 code, e.g. `INVALID_TRANSITION` or `CANARY_NOT_HEALTHY`), the gate reads `GetEscrow` for every escrow of the claim. Each one the ledger has QUARANTINED is mirrored in Postgres:
  - QUARANTINED, reason `auditor_hold`, `security_hold = TRUE`;
  - no admin override, no self-heal;
  - the payout is FAILED with no Settle. When at least one escrow was mirrored, the reason is `ledger_auditor_hold` and the agent gets 409 `balance_under_review`: the held escrows have left the balance, so claiming again pays the rest. Any other refusal is FAILED `ledger_<code>` with 503 `temporarily_unavailable`, because it clears only when an operator fixes the cause (clock skew, a DEAD row, a bad deploy).
- A gateway Release or Quarantine refused with `LOCKED_BY_AUDITOR`, or a Quarantine answered as a no-op with `lockedBy = auditor`, mirrors the same way. Its row is `SUPERSEDED`, not dead.
- The worker polls `auditor_hold` escrows every `LEDGER_AUDITOR_POLL_MS`. When the auditor releases one, it goes back to HELD with the ledger's `releaseDueAt`, and `security_hold` is cleared.

**Not on the ledger yet → not claimable.**
- With the ledger on, an escrow with an undelivered (`PENDING` / `DEAD`) outbox row is out of the claimable balance and shows as a pending accrual.
- The claim filter also requires `release_due_at <= NOW() - 5 min`. The chaincode checks maturity against the gateway-set tx timestamp, and the margin absorbs clock skew.
- When enabled, preflight refuses to start if the Postgres and host clocks differ by more than 60 s.

## Preimages and keys

**stateHash** = HMAC-SHA256(`LEDGER_STATE_HMAC_KEY`, preimage v1), lowercase hex.

- Preimage v1 is the canonical JSON (keys sorted, no whitespace) of the escrow **as it was when its COMMIT was queued** (a snapshot; later changes reach the chain as Quarantine / Release, not as a new stateHash):

  ```json
  {"agentId","amountCents","decision","escrowId","failSafe","grossCents","modelSha256","modelVersion",
   "mpesaReceiptId","quarantineReason","rawPayloadHash","releaseDueAt","transactionId","v":1,"verificationId"}
  ```

- `amountCents` and `grossCents` are integers. `releaseDueAt` is RFC3339 UTC with milliseconds.
- `modelSha256` and `quarantineReason` may be `null`.
- The verification is the escrow's latest event evaluated at or before the COMMIT row was queued (at settle time, the INITIAL one).
- The hash and its key id are stored on `escrow_accounts.ledger_state_hash` / `ledger_state_key_id`.

**consentDigest** = HMAC-SHA256(`LEDGER_CONSENT_HMAC_KEY`, `payouts.consent_hash` as hex text).

- It is stored with its key id on `payouts.ledger_consent_digest` / `ledger_consent_key_id`.
- The raw consent hash is SHA-256 over a preimage that includes the MSISDN, so it never goes on chain.

Key handling:
- Both keys are at least 32 bytes and use the same encodings as `PII_HMAC_KEY` (`base64:…`, `hex:…` or UTF-8). Their ids come from `*_KEY_ID` (default `k1`).
- They must differ from each other and from `PII_HMAC_KEY`, so they can be given to the auditor without exposing the PII hashes.
- An auditor verifies an escrow by recomputing that snapshot, then the HMAC with the key named by `ledger_state_key_id`; the result must equal the chain's `stateHash`. The snapshot is rebuilt as:
  - immutable fields from Postgres: `escrowId`, `transactionId`, `agentId`, `mpesaReceiptId`, `rawPayloadHash`, `amountCents`, `grossCents`;
  - `quarantineReason`, `releaseDueAt`, `modelVersion`, `decision`, `failSafe` from that escrow's COMMIT row (`ledger_outbox.request`), since they change after the COMMIT (`""` in the request is `null` in the preimage; the request's model fields equal the verification event's unless they had to be sanitised);
  - `modelSha256` from that verification event (the request carries `""` for NULL);
  - `verificationId` = the escrow's latest verification event with `evaluated_at` <= that row's `created_at`.
- **Rotation:** set a new key with a new id. New rows use it. Old rows keep the id they were made with, so the auditor needs the old key to verify them. Nothing on chain is rewritten.

**Block hash:** SHA-256 of the DER `SEQUENCE{INTEGER number, OCTET STRING previous_hash, OCTET STRING data_hash}` (Fabric's `BlockHeaderHash`). Block N+1's `previous_hash` equals it, and `make fabric-ledger-e2e` checks that.

## PII

Only UUIDs, digests, integer cents, codes and versions go on chain. Names, MSISDNs, M-Pesa receipts and raw consent hashes never do. The receipt is only inside the HMAC preimage. `failureCode` and reasons are sanitised to `^[a-z][a-z0-9_]{0,39}$`:
- lowercased;
- anything outside `[a-z0-9_]` becomes `_`;
- an `x` is prefixed if needed;
- cut to 40 characters.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FABRIC_ENABLED` | `false` | Off: outbox rows are still written (when the keys are set), nothing is sent, and claims skip the gate and the filter. On: preflight requires everything below. |
| `FABRIC_ORG_DIR` | none | `blockchain/network/organizations/peerOrganizations/merchant.salesmesh.test`. The identity and TLS files are read from it on every start and never copied. |
| `FABRIC_PEER_ENDPOINT` / `FABRIC_PEER_HOST_ALIAS` | `127.0.0.1:7051` / `peer0.merchant.salesmesh.test` | Peer address and TLS name |
| `FABRIC_MSP_ID` / `FABRIC_CHANNEL` / `FABRIC_CHAINCODE` / `FABRIC_USER` | `MerchantMSP` / `commissionchannel` / `commission` / `gateway` | |
| `FABRIC_AUTHORISE_TIMEOUT_MS` | `10000` | How long the claim gate retries |
| `LEDGER_STATE_HMAC_KEY`, `LEDGER_CONSENT_HMAC_KEY` (+ `_ID`) | none | The keys above. Without them nothing is enqueued (preflight warns). |
| `LEDGER_WORKER_INTERVAL_MS`, `LEDGER_WORKER_BATCH`, `LEDGER_WORKER_LEASE_MS`, `LEDGER_BACKOFF_BASE_MS`, `LEDGER_BACKOFF_MAX_MS`, `LEDGER_AUDITOR_POLL_MS` | 2 s, 20, 120 s, 2 s, 5 min, 60 s | Worker tuning |

## Operating it

Setup:
1. `make fabric-up`.
2. Deploy the chaincode: `bash blockchain/network/scripts/deploy_chaincode.sh commission blockchain/chaincode 1.0 1`.
3. Set the variables above.
4. Run `npm run build && npm run ledger:init`.

`ledger:init` runs `InitLedger` (idempotent). It then queues a COMMIT for every HELD or QUARANTINED escrow that has none, for example escrows settled before the keys were set. Where the commit alone would give a different status than Postgres, it adds a Release or Quarantine. Run it after enabling the ledger on an existing database (escrows settled before the keys were set). History before #10 (RELEASED escrows, old payouts) is not backfilled. Payouts claimed while the ledger was off keep the ledger in step on their own, without a Settle: a FAILED one queues a Quarantine for each security-held escrow (the others are already HELD on chain), and a PAID one supersedes its escrows' still-PENDING outbox rows (`paid before the ledger was enabled`), so they are never published as HELD; like pre-#10 history they have no on-chain record of the payout.

- **Health:** `/health/details` shows:
  - `ledgerOutbox {enabled, pending, dead, oldestPendingAgeSeconds, auditorHolds}`;
  - `workers.ledger`;
  - the `ledger` counters: delivered, retried, dead, superseded, auditorReleased, authorised, authoriseRefused, authoriseUnavailable, mirrored.
- **Runtime:** the gateway loads `@hyperledger/fabric-gateway` only when the ledger is used. It needs Node ≥ 20.19 or ≥ 22.12, because the library requires the ESM-only `@noble/curves`. The jest e2e needs `NODE_OPTIONS=--experimental-vm-modules`, and the script sets it.
