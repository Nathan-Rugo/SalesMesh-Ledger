# Daraja reconciliation runbook

Daraja does not reliably redeliver callbacks, so money can move without the gateway learning of it.
Two tools close that gap (spec gh-6-recon):

1. **STK Query sweep** (automatic, `RECONCILE_ENABLED=true`). Overdue ACCEPTED STK requests (no
   callback `STK_TTL + RECONCILE_GRACE_MS` after initiation) are asked about through the Daraja STK
   Push Query API.
   - Paid → `PAID_UNCONFIRMED`: the money moved, but the query never returns a receipt.
   - Cancelled, timed out, wrong PIN or insufficient funds → `FAILED` with that code.
   - Anything else is retried with backoff; after `RECONCILE_MAX_ATTEMPTS` → `RECONCILE_EXHAUSTED`.
2. **Statement import** (operator, `npm run reconcile:import`). Supplies the receipts for both STK and C2B
   payments. Every missing payment goes through the normal intake → ML scoring → escrow pipeline,
   flagged `RECONCILED`.

Watch `GET /health/details` → `reconciliation`:

- `paidUnconfirmed`: paid, receipt still missing.
- `reconcileExhausted`: the sweep gave up.
- `overdueAccepted` and `oldestOverdueAcceptedAgeSeconds`.
- `lastSweepAt` and `lastImportAt`.
- `latestImport`: status and time of the latest import. A FAILED or long-RUNNING import needs an operator.
- `openExceptions`: open CLAWBACK_DUE and RELEASED_NOT_ON_STATEMENT exceptions, by kind.
- the sweep counters.

A growing `paidUnconfirmed` means it is time to import a statement.

## 1. Export the statement

1. In the M-Pesa org portal, open the paybill / till's **Utility Account** statement.
2. Choose a Time Period that covers the gap (for example the last 2 days), and export as **CSV**.
   XLS and PDF are refused, and so is a CSV re-saved by Excel, because Excel rewrites the dates as
   ambiguous `m/d/yyyy`.
3. Keep the preamble lines (Short Code, Account, Time Period) at the top of the file. The import checks
   that:
   - the Short Code equals `DARAJA_BUSINESS_SHORTCODE` (or `DARAJA_PARTY_B`);
   - the Account equals `RECONCILE_EXPECTED_ACCOUNT` when that is set;
   - every row lies inside the Time Period.

## 2. Run an import

Always dry-run first. It prints what would happen and writes only a run record.

```sh
cd backend/gateway && npm run build
npm run reconcile:import -- /path/statement.csv --operator 0722000000 --dry-run
npm run reconcile:import -- /path/statement.csv --operator 0722000000
```

- `--operator` must be an active `MERCHANT_ADMIN`, given as a phone number or a user_id. It is recorded on the run.
- `--confirm` is required when any of these apply. The dry run says which ones do.
  - The new payments exceed `RECONCILE_CONFIRM_MAX_ROWS` or `RECONCILE_CONFIRM_MAX_AMOUNT` (KES).
  - Two-way reconciliation would security-hold more than `RECONCILE_TWO_WAY_MAX_HOLDS` (default 5) payments.
  - The running Balance column breaks: a row may have been inserted, edited or dropped. The report names the lines.
- Only one import runs at a time; a second one is refused.
- A bad file (missing column, unparseable time or amount, a receipt repeated with different values)
  is rejected as a whole, with line numbers. Nothing is written. The exit code is 1.
- A crashed import leaves a RUNNING run. The next import of any file marks it FAILED.
- Re-importing the same file (same SHA-256) after it COMPLETED is a recorded no-op. After a FAILED run
  it resumes: rows already written are recognised by their receipt and verified, never duplicated.
- The original file is copied to `RECONCILE_EVIDENCE_DIR/<sha256>/` (directory 0700, file 0600). It
  contains customer phone numbers and names. Keep it 5 years with restricted access
  (`docs/compliance/data-retention.md`).

The CLI is a separate process and does not wake the gateway. Recovered rows settle on the gateway
settlement worker's next poll, within `WORKER_POLL_INTERVAL_MS` (default 1 s).

## 3. Read the report

Each action line names the CSV line and receipt. The summary counts:

| Line | Meaning | Action |
|---|---|---|
| bound to an STK request | exactly one STK request matched: agent code = A/C No., amount, initiation time within STK_TTL (± clock skew), and the phone or masked-phone fingerprint | none: it settles and consumes the request |
| by account number | no single STK match (none, or ambiguous). Settles by agent code like a C2B payment, with `corroborated=false` | unknown agent code → the row stays UNRESOLVED (`requeue` after fixing the code) |
| STK status conflict | the statement shows a payment for a FAILED / REJECTED request | review: the row is held UNRESOLVED |
| verified | we already had this receipt with the same amount, agent code and time | none |
| amount mismatch / attribution conflict | our record differs from the bank's | review: the escrow is security-held QUARANTINED |
| reversal | `PAYMENT_REVERSED`: the escrow is security-held (partial amounts too) | `CLAWBACK_DUE` exception if it was already RELEASED: recover the commission manually |
| missing from the statement | a callback-origin receipt paid to this statement's shortcode inside the Time Period that the bank does not list. Only checked when `RECONCILE_EXPECTED_ACCOUNT` is set (otherwise a warning). STK callbacks count only for the shortcode they are paid into (`DARAJA_PARTY_B`, or the business shortcode) | review (possible forged callback): its escrow is security-held, or a `RELEASED_NOT_ON_STATEMENT` exception is raised |
| known receipt, not a sale | the statement lists a receipt we hold as a payment, but as failed / withdrawal / not whitelisted | review: `RECONCILE_ATTRIBUTION_CONFLICT`, escrow security-held |
| ignored | charges, withdrawals, transfers / settlements (not in `RECONCILE_CREDIT_TYPES`), non-Completed rows | none |

Nothing is ever paid out or clawed back automatically. Open exceptions:

```sql
SELECT kind, mpesa_receipt_id, related_receipt_id, amount, detail, created_at
  FROM reconciliation_exceptions WHERE resolved_at IS NULL ORDER BY created_at;
```

Security events raised here: `RECONCILE_AMOUNT_MISMATCH`, `RECONCILE_ATTRIBUTION_CONFLICT`,
`PAYMENT_REVERSED`, `RECONCILE_NOT_ON_STATEMENT`, `STK_STATUS_CONFLICT`, and
`RECONCILED_CALLBACK_LATE` (informational).

## Late genuine callbacks

When Safaricom's real callback arrives after a payment was recovered, the gateway answers 200. It
confirms the recovered row (`RECONCILED_CALLBACK_LATE`) only when attribution is positively verified:

- **STK:** the callback's CheckoutRequestID belongs to an unconsumed (or this) request whose agent
  code is the recovered row's account. A row the import could not bind is then bound, and that
  request is consumed.
- **C2B:** the BillRefNumber equals the recovered account.

A phone that contradicts the stored one also blocks confirmation. A masked phone, a provider-hashed
phone, or a hash under a retired key cannot be compared and never counts as a contradiction.
Escrow is never changed by a confirmation.

- A different amount is a `PAYLOAD_MUTATION`.
- Anything not attributable is a `RECONCILE_ATTRIBUTION_CONFLICT`.
- Of two different concurrent deliveries, one confirms and the other is a `PAYLOAD_MUTATION`.

All of these put the escrow on security hold.

## Deploying migration 003

`003_reconciliation.sql` runs in one transaction. It holds ACCESS EXCLUSIVE locks on `stk_requests`,
`mpesa_callbacks` and `security_events` through a full backfill and constraint validation. Apply it
in a maintenance window with the gateway stopped.

## Not covered

- The Pull Transactions and Transaction Status APIs (they need Safaricom onboarding).
- XLS / PDF statements.
- Automatic payouts or clawbacks.
