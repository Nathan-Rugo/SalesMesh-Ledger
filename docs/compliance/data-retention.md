# Data retention: authentication data (spec gh-5)

The settlement worker's housekeeping (every `WORKER_SWEEP_INTERVAL_MS`, default 60 s) purges:

| Data | Contains | Kept for | Setting |
|---|---|---|---|
| `refresh_tokens` | SHA-256 of the token, creating client IP | 30 days after it expired or was revoked | fixed |
| `auth_events` | login/refresh/PIN audit rows, raw client IP, keyed hashes of phone and user agent | 90 days | `AUTH_EVENTS_RETENTION_DAYS` |
| `stk_failed_callbacks` | CheckoutRequestID and result code of a failed STK push not yet matched to a request | 1 day | fixed |

Not purged here: `security_events` (alarms and admin CLI actions: kept as the security audit
trail) and `stk_requests` (financial records; they reach a final status — ACCEPTED, REJECTED,
FAILED or EXPIRED — and stay with the settlement records).

No table stores a PIN, a token, a raw customer MSISDN or a raw user agent. A refresh-token family
also ends `REFRESH_FAMILY_MAX_DAYS` (default 30) after login regardless of activity.

## Reconciliation records (spec gh-6-recon)

These are financial records: keep them **5 years** (Kenya Tax Procedures Act, 2015, s. 23). Access is
restricted to MERCHANT_ADMIN operators and auditors. Nothing purges them automatically: delete them
by hand once the 5 years have passed.

| Data | Contains | Kept for | Access |
|---|---|---|---|
| `reconcile-evidence/<sha256>/` (`RECONCILE_EVIDENCE_DIR`) | the original M-Pesa statement CSVs, **including customer phone numbers and names** | 5 years from the import | directory 0700, files 0600, owned by the service account; never in backups readable by others, never in git |
| `reconciliation_runs` | file SHA-256, operator user_id, counts, evidence path (no customer data) | 5 years | database admins / auditors |
| `reconciliation_exceptions` | receipts, amounts and escrow ids of CLAWBACK_DUE / RELEASED_NOT_ON_STATEMENT cases | 5 years after `resolved_at` | database admins / auditors |
