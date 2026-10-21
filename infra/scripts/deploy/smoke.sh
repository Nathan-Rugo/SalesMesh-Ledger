#!/usr/bin/env bash
# Post-deploy check through Caddy (docs/architecture/deployment.md): a valid TLS certificate, HTTP ->
# HTTPS redirect, gateway readiness, the PWA's /offline page, and a 404 for a callback with a wrong token.
#
#   bash infra/scripts/deploy/smoke.sh [PUBLIC_HOST]     # default: PUBLIC_HOST from the root .env
#   INSECURE=1 bash infra/scripts/deploy/smoke.sh localhost   # local run on Caddy's internal CA
#
# Prints SMOKE PASS, or names every failed check and exits 1.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
host="${1:-}"
if [[ -z $host && -f $ROOT/.env ]]; then
  host=$(grep -E '^PUBLIC_HOST=' "$ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '\r')
fi
[[ -n $host ]] || { echo "smoke: pass PUBLIC_HOST or create .env" >&2; exit 2; }

opts=(-sS -o /dev/null -w '%{http_code}' --max-time 15)
[[ ${INSECURE:-0} == 1 ]] && opts+=(-k)
fails=0
check() {   # check <name> <expected status> <curl args...>
  local name=$1 want=$2 got
  shift 2
  got=$(curl "${opts[@]}" "$@" 2>&1) || true
  if [[ $got == "$want" ]]; then echo "ok   $name ($got)"; else echo "FAIL $name: expected $want, got $got"; fails=$((fails + 1)); fi
}

# A certificate error makes curl fail (code 000) before any status, so every https check proves TLS.
check "TLS + PWA /offline" 200 "https://$host/offline"
check "gateway readiness" 200 "https://$host/api/v1/health/ready"
check "HTTP redirects to HTTPS" 308 "http://$host/offline"
check "callback with a wrong token" 404 -X POST -H 'Content-Type: application/json' -d '{}' \
  "https://$host/api/v1/mpesa/callback/smoke-wrong-token"
# Only /api/* reaches the gateway, so its /health/details falls through to the PWA's 404.
check "gateway /health/details not exposed" 404 "https://$host/health/details"

if [[ ${INSECURE:-0} != 1 ]]; then
  end=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -n $end ]]; then echo "ok   certificate valid until $end"; else echo "FAIL cannot read the certificate"; fails=$((fails + 1)); fi
fi

if (( fails )); then echo "SMOKE FAIL ($fails)"; exit 1; fi
echo "SMOKE PASS"
