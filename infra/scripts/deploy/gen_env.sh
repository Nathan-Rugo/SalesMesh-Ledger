#!/usr/bin/env bash
# Writes the root .env (mode 600) from .env.example with random secrets, so no secret is ever made by
# hand or committed: DB / Redis passwords, PII and ledger HMAC keys, the Daraja callback token (with the
# literal token in every Daraja URL), the metrics token and an RS256 JWT key in backend/gateway/keys/.
#
#   bash infra/scripts/deploy/gen_env.sh [--force] [PUBLIC_HOST]
#
# PUBLIC_HOST defaults to <this machine's public IPv4>.sslip.io. An existing .env is refused unless
# --force, which means re-host / refresh: it backs the old file up to .env.bak.<timestamp>.<pid>, KEEPS
# every non-empty value in it (secrets, the callback token, hand-entered Daraja / Africa's Talking
# credentials) and recomputes only the host-derived keys (PUBLIC_HOST, PUBLIC_ORIGIN, CORS_ORIGINS, the
# four Daraja URLs) and MODEL_SHA256. Secrets are generated only for keys missing or empty. A true wipe
# is `make deploy-down`, `docker volume rm salesmesh_pg_data salesmesh_redis_data`, then delete .env.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/.env"
KEYS_DIR="$ROOT/backend/gateway/keys"
KID=prod-1

die() { echo "gen_env: $*" >&2; exit 1; }
warn() { echo "gen_env: warning: $*" >&2; }

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
[[ -f $ROOT/.env.example ]] || die "$ROOT/.env.example not found"
# The gateway container runs as node (uid 1000) and reads the mode-600 JWT key and the Fabric crypto.
[[ $(id -u) == 1000 ]] || warn "you are uid $(id -u), not 1000: the gateway (uid 1000) cannot read the mode-600 JWT key / Fabric crypto you own"

declare -A old=()
if [[ -e $ENV_FILE ]]; then
  (( force )) || die "$ENV_FILE exists; re-run with --force to re-host / refresh it (secrets are kept, a backup is made)"
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] && [[ -n ${BASH_REMATCH[2]} ]] && old[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
  done <"$ENV_FILE"
fi

if [[ -z $host ]]; then
  ip=$(curl -fsS --max-time 5 https://checkip.amazonaws.com | tr -d '[:space:]') || die "cannot find the public IP; pass PUBLIC_HOST"
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "unexpected public IP '$ip'; pass PUBLIC_HOST"
  host="$ip.sslip.io"
fi
[[ $host =~ ^[A-Za-z0-9.-]+$ ]] || die "PUBLIC_HOST '$host' is not a host name"

hex() { openssl rand -hex 32; }
b64() { printf 'base64:%s' "$(openssl rand -base64 32)"; }

tmp=$(mktemp "$ROOT/.env.tmp.XXXXXX")
trap 'rm -f "$tmp" "$tmp.n" "$tmp.u"' EXIT

# Updates as KEY=VALUE lines; the last one for a key wins. Old values first, then computed ones.
emit() { printf '%s=%s\n' "$1" "$2" >>"$tmp.u"; }
: >"$tmp.u"
for k in "${!old[@]}"; do emit "$k" "${old[$k]}"; done
keep_or() { [[ -n ${old[$1]:-} ]] || emit "$1" "$2"; }   # only when missing / empty in the old .env

keep_or NODE_ENV production
keep_or DB_HOST postgres
keep_or REDIS_HOST redis
keep_or ML_SERVICE_URL http://ml-engine:8000
keep_or TRUST_PROXY 1
keep_or JWT_PRIVATE_KEY_FILE "keys/jwt-$KID.key.pem"
keep_or JWT_KEY_ID "$KID"
keep_or DB_PASSWORD "$(hex)"
keep_or REDIS_PASSWORD "$(hex)"
keep_or PII_HMAC_KEY "$(b64)"
keep_or LEDGER_STATE_HMAC_KEY "$(b64)"
keep_or LEDGER_CONSENT_HMAC_KEY "$(b64)"
keep_or HEALTH_METRICS_TOKEN "$(hex)"
keep_or MPESA_CALLBACK_TOKEN "$(hex)"
token=${old[MPESA_CALLBACK_TOKEN]:-$(grep '^MPESA_CALLBACK_TOKEN=' "$tmp.u" | tail -n1 | cut -d= -f2-)}

# Host-derived: always recomputed.
base="https://$host/api/v1/mpesa"
emit PUBLIC_HOST "$host"
emit PUBLIC_ORIGIN "https://$host"
emit CORS_ORIGINS "https://$host"
emit DARAJA_CALLBACK_URL "$base/callback/$token"
emit DARAJA_C2B_VALIDATION_URL "$base/c2b/validation/$token"
emit DARAJA_B2C_RESULT_URL "$base/b2c/result/$token"
emit DARAJA_B2C_TIMEOUT_URL "$base/b2c/timeout/$token"

shopt -s nullglob
shas=("$ROOT"/ml-engine/models/*.sha256)
if (( ${#shas[@]} == 1 )); then
  emit MODEL_SHA256 "$(cut -d' ' -f1 "${shas[0]}")"
else
  warn "found ${#shas[@]} ml-engine/models/*.sha256 files (need exactly 1): MODEL_SHA256 pin left as it was (empty = off)"
fi

# One pass (CRLF from a Windows checkout normalised to LF): replace the first line of each key in .env.example, drop later duplicates, append new keys.
awk '
  NR == FNR { i = index($0, "="); k = substr($0, 1, i - 1); if (!(k in v)) order[++n] = k; v[k] = substr($0, i + 1); next }
  { sub(/$/, ""); i = index($0, "="); k = (i > 1 && $0 !~ /^#/) ? substr($0, 1, i - 1) : "" }
  k != "" && (k in v) { if (!(k in done)) print k "=" v[k]; done[k] = 1; next }
  { print }
  END { for (j = 1; j <= n; j++) if (!(order[j] in done)) print order[j] "=" v[order[j]] }
' "$tmp.u" "$ROOT/.env.example" >"$tmp.n"
mv "$tmp.n" "$tmp"
chmod 600 "$tmp"

# JWT signing key before .env is moved into place, so a failure here leaves a re-run possible.
# Never replaced: rotating it would log every user out.
mkdir -p "$KEYS_DIR"
key="$KEYS_DIR/jwt-$KID.key.pem"
if [[ ! -f $key ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$key" 2>/dev/null
  openssl pkey -in "$key" -pubout -out "$KEYS_DIR/jwt-$KID.pub.pem"
fi

[[ -e $ENV_FILE ]] && cp -p "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S).$$"
mv "$tmp" "$ENV_FILE"
rm -f "$tmp.u"
trap - EXIT

echo "gen_env: wrote $ENV_FILE (mode 600) for https://$host"
(( force )) || echo "gen_env: now set DARAJA_CONSUMER_KEY/SECRET, DARAJA_PASSKEY, DARAJA_B2C_SECURITY_CREDENTIAL and AFRICASTALKING_* by hand"
