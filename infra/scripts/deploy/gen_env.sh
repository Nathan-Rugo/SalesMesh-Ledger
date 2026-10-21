#!/usr/bin/env bash
# Writes the root .env (mode 600) from .env.example with random secrets, so no secret is ever made by
# hand or committed: DB / Redis passwords, PII and ledger HMAC keys, the Daraja callback token (with the
# literal token in every Daraja URL), the metrics token and an RS256 JWT key in backend/gateway/keys/.
#
#   bash infra/scripts/deploy/gen_env.sh [--force] [PUBLIC_HOST]
#
# PUBLIC_HOST defaults to <this machine's public IPv4>.sslip.io. An existing .env is refused unless
# --force, which first copies it to .env.bak.<timestamp>. Daraja / Africa's Talking credentials are not
# generated: fill them in afterwards (docs/architecture/deployment.md).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/.env"
KEYS_DIR="$ROOT/backend/gateway/keys"
KID=prod-1

die() { echo "gen_env: $*" >&2; exit 1; }

force=0
host=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -*) die "unknown option $arg (usage: gen_env.sh [--force] [PUBLIC_HOST])" ;;
    *) host=$arg ;;
  esac
done

command -v openssl >/dev/null || die "openssl not found"
if [[ -e $ENV_FILE ]]; then
  (( force )) || die "$ENV_FILE exists; re-run with --force to replace it (a backup is kept)"
  cp -p "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
fi

if [[ -z $host ]]; then
  ip=$(curl -fsS --max-time 5 https://checkip.amazonaws.com | tr -d '[:space:]') || die "cannot find the public IP; pass PUBLIC_HOST"
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "unexpected public IP '$ip'; pass PUBLIC_HOST"
  host="$ip.sslip.io"
fi
[[ $host =~ ^[A-Za-z0-9.-]+$ ]] || die "PUBLIC_HOST '$host' is not a host name"

hex() { openssl rand -hex 32; }
b64() { printf 'base64:%s' "$(openssl rand -base64 32)"; }
token=$(hex)
base="https://$host/api/v1/mpesa"
sha_file="$ROOT/ml-engine/models/risk_cascade_v1.0.0.joblib.sha256"
model_sha=""
[[ -f $sha_file ]] && model_sha=$(cut -d' ' -f1 "$sha_file")

# KEY=VALUE pairs; values go through ENVIRON so no character needs escaping.
updates=(
  "NODE_ENV=production"
  "PUBLIC_HOST=$host"
  "MODEL_SHA256=$model_sha"
  "DB_HOST=postgres"
  "REDIS_HOST=redis"
  "ML_SERVICE_URL=http://ml-engine:8000"
  "DB_PASSWORD=$(hex)"
  "REDIS_PASSWORD=$(hex)"
  "PII_HMAC_KEY=$(b64)"
  "LEDGER_STATE_HMAC_KEY=$(b64)"
  "LEDGER_CONSENT_HMAC_KEY=$(b64)"
  "HEALTH_METRICS_TOKEN=$(hex)"
  "MPESA_CALLBACK_TOKEN=$token"
  "DARAJA_CALLBACK_URL=$base/callback/$token"
  "DARAJA_C2B_VALIDATION_URL=$base/c2b/validation/$token"
  "DARAJA_B2C_RESULT_URL=$base/b2c/result/$token"
  "DARAJA_B2C_TIMEOUT_URL=$base/b2c/timeout/$token"
  "TRUST_PROXY=1"
  "PUBLIC_ORIGIN=https://$host"
  "CORS_ORIGINS=https://$host"
  "JWT_PRIVATE_KEY_FILE=keys/jwt-$KID.key.pem"
  "JWT_KEY_ID=$KID"
)

tmp=$(mktemp "$ROOT/.env.tmp.XXXXXX")
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"
cp "$ROOT/.env.example" "$tmp"
for kv in "${updates[@]}"; do
  K=${kv%%=*} V=${kv#*=} awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$tmp" >"$tmp.n"
  mv "$tmp.n" "$tmp"
done
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
trap - EXIT

# JWT signing key (kept across --force: rotating it would log every user out).
mkdir -p "$KEYS_DIR"
key="$KEYS_DIR/jwt-$KID.key.pem"
if [[ ! -f $key ]]; then
  (umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$key" 2>/dev/null)
  openssl pkey -in "$key" -pubout -out "$KEYS_DIR/jwt-$KID.pub.pem"
fi

echo "gen_env: wrote $ENV_FILE (mode 600) for https://$host"
echo "gen_env: now set DARAJA_CONSUMER_KEY/SECRET, DARAJA_PASSKEY, DARAJA_B2C_SECURITY_CREDENTIAL and AFRICASTALKING_* by hand"
