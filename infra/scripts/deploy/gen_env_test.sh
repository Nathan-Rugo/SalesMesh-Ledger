#!/usr/bin/env bash
# Tests gen_env.sh in a temporary copy of the root files it needs. Prints GEN_ENV TEST PASS or exits 1.
#   bash infra/scripts/deploy/gen_env_test.sh
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/infra/scripts/deploy" "$T/ml-engine/models"
cp "$SRC/infra/scripts/deploy/gen_env.sh" "$T/infra/scripts/deploy/"
cp "$SRC/.env.example" "$T/"
echo "abc123  risk.joblib" >"$T/ml-engine/models/risk.joblib.sha256"
GEN="$T/infra/scripts/deploy/gen_env.sh"
E="$T/.env"

fail() { echo "FAIL: $*" >&2; exit 1; }
val() { grep "^$1=" "$E" | cut -d= -f2-; }
count() { grep -c "^$1=" "$E" || true; }

bash "$GEN" a.example.test >/dev/null 2>&1 || fail "first run"
first=$(cat "$E")
if [[ $(uname -s) != MINGW* && $(uname -s) != MSYS* ]]; then   # NTFS has no POSIX modes
  [[ $(stat -c %a "$E") == 600 ]] || fail ".env mode is $(stat -c %a "$E")"
fi
[[ $(val MODEL_SHA256) == abc123 ]] || fail "MODEL_SHA256 not pinned"
[[ $(val DB_PASSWORD) =~ ^[0-9a-f]{64}$ ]] || fail "DB_PASSWORD not generated"
[[ $(val PII_HMAC_KEY) == base64:* ]] || fail "PII_HMAC_KEY not generated"

tok=$(val MPESA_CALLBACK_TOKEN)
[[ $tok =~ ^[0-9a-f]{64}$ ]] || fail "callback token"
for p in callback c2b/validation b2c/result b2c/timeout; do
  grep -qx "DARAJA_[A-Z0-9_]*_URL=https://a.example.test/api/v1/mpesa/$p/$tok" "$E" || fail "no Daraja URL ending in $p/<token>"
done

if bash "$GEN" a.example.test >/dev/null 2>&1; then fail "second run without --force succeeded"; fi
[[ $(cat "$E") == "$first" ]] || fail "refused run changed .env"

keyhash=$(sha256sum "$T/backend/gateway/keys/jwt-prod-1.key.pem")
sed -i 's/^DARAJA_CONSUMER_KEY=.*/DARAJA_CONSUMER_KEY=hand-set-key/' "$E"
before=$(cat "$E")
bash "$GEN" --force a.example.test >/dev/null 2>&1 || fail "--force run"
ls "$T"/.env.bak.* >/dev/null 2>&1 || fail "--force made no backup"
[[ $(sha256sum "$T/backend/gateway/keys/jwt-prod-1.key.pem") == "$keyhash" ]] || fail "JWT key changed"
[[ $(cat "$E") == "$before" ]] || fail "--force with the same host changed .env"

bash "$GEN" --force b.example.test >/dev/null 2>&1 || fail "--force re-host"
diff <(grep -v -E '^(PUBLIC_HOST|PUBLIC_ORIGIN|CORS_ORIGINS|DARAJA_(CALLBACK|C2B_VALIDATION|B2C_RESULT|B2C_TIMEOUT)_URL)=' <<<"$before") \
     <(grep -v -E '^(PUBLIC_HOST|PUBLIC_ORIGIN|CORS_ORIGINS|DARAJA_(CALLBACK|C2B_VALIDATION|B2C_RESULT|B2C_TIMEOUT)_URL)=' "$E") >/dev/null ||
  fail "re-host changed a non-host key"
for k in DB_PASSWORD PII_HMAC_KEY MPESA_CALLBACK_TOKEN; do
  [[ $(val $k) == "$(grep "^$k=" <<<"$before" | cut -d= -f2-)" ]] || fail "$k not kept"
done
[[ $(val DARAJA_CONSUMER_KEY) == hand-set-key ]] || fail "hand-set DARAJA_CONSUMER_KEY lost"
[[ $(val PUBLIC_ORIGIN) == https://b.example.test ]] || fail "PUBLIC_ORIGIN not re-hosted"
[[ $(val DARAJA_CALLBACK_URL) == "https://b.example.test/api/v1/mpesa/callback/$tok" ]] || fail "callback URL not re-hosted"

for k in NODE_ENV PUBLIC_HOST PUBLIC_ORIGIN CORS_ORIGINS MODEL_SHA256 DB_HOST REDIS_HOST ML_SERVICE_URL TRUST_PROXY \
  JWT_PRIVATE_KEY_FILE JWT_KEY_ID DB_PASSWORD REDIS_PASSWORD PII_HMAC_KEY LEDGER_STATE_HMAC_KEY LEDGER_CONSENT_HMAC_KEY \
  HEALTH_METRICS_TOKEN MPESA_CALLBACK_TOKEN DARAJA_CALLBACK_URL DARAJA_C2B_VALIDATION_URL DARAJA_B2C_RESULT_URL DARAJA_B2C_TIMEOUT_URL; do
  [[ $(count "$k") == 1 ]] || fail "$k appears $(count "$k") times"
done
ls "$T"/.env.tmp.* >/dev/null 2>&1 && fail "temp files left behind"

echo "GEN_ENV TEST PASS"
