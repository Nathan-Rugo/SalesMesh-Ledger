# Runbook: rotating `PII_HMAC_KEY`

The gateway never stores a payer MSISDN. Two hashes are stored instead. Both are
HMAC-SHA256 under one secret, `PII_HMAC_KEY`, and both carry a key-id prefix
(`k1:<64 hex>`):

| Hash | Where it is stored | What it is used for |
|---|---|---|
| Payload hash (domain `payload`) | Redis claim value, `mpesa_callbacks.raw_payload_hash`, `transactions.raw_payload_hash` | Dedup, and detecting a mutated retry of the same receipt |
| Counterparty hash (domain `counterparty`) | Redacted `mpesa_callbacks.payload`, `transactions.counterparty_hash` | The `counterparty_id` that ml-engine uses for `recipient_reuse_count` |

The key is checked at startup and must be at least 32 bytes. If it is missing or too
short, the gateway and its workers refuse to start.

## When to rotate

Rotate when the key is suspected leaked or a team member with access leaves. Otherwise
follow your scheduled key-management policy.

## Procedure

1. **Generate a new key.**
   ```sh
   node -e "console.log('base64:' + require('crypto').randomBytes(32).toString('base64'))"
   ```
2. **Deploy with both keys.**
   - Set the new key: `PII_HMAC_KEY=<new>` and `PII_HMAC_KEY_ID=k2`.
   - Keep the old key: `PII_HMAC_KEY_PREVIOUS=<old>` and `PII_HMAC_KEY_PREVIOUS_ID=k1`.

   The hot path compares an incoming payload against a stored `k1:` hash using the
   previous key. A Daraja retry of a callback first received under `k1` therefore still
   counts as a duplicate, and does not raise a false mutation alarm.
3. **Keep the previous key** for at least the dedup window:
   - `REDIS_IDEMPOTENCY_TTL_MS`, 24 h by default;
   - and Daraja's retry window.
4. **Remove the previous key.** Unset `PII_HMAC_KEY_PREVIOUS*` and redeploy.
   - From then on, a stored hash whose key id is no longer configured cannot be
     verified.
   - The hot path then fails closed: it raises a mutation alarm, which security-holds
     that receipt's escrow.
5. **Destroy the old key material.**

## Counterparty-reuse reset window (expected degradation)

Counterparty hashes are not re-computable: the MSISDN is never stored. After a rotation:

- New transactions get `k2:` counterparty hashes, while their history rows still carry
  `k1:` hashes.
- `recipient_reuse_count` (a 24 h window in ml-engine) can therefore not match a payer
  across the rotation. For up to **24 h after the switch**, reuse is under-counted for
  payers seen before the switch.
- The other features (velocity, split ratio, entropy, z-score, amount/median ratio) do
  not depend on the counterparty, so they are unaffected.
- Plan rotations for low-traffic periods, and note the switch time in the audit log so
  that analysts can discount the window.
- Legacy rows migrated from the original schema carry `legacy:<receipt>` and never
  match any payer. This is the same unique-per-receipt behaviour as an absent MSISDN.

## Verification after rotation

- `GET /health` reports normal queue depth. The DEAD/UNRESOLVED counts and
  `failSafeQuarantined` do not grow.
- `security_events` shows no burst of `PAYLOAD_MUTATION` rows in the hours after the
  switch.
