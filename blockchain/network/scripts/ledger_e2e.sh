#!/usr/bin/env bash
# End-to-end check of the gateway's ledger sync (#10) on the testnet: up -> deploy commission v1.0 ->
# throwaway Postgres -> the gateway e2e suite (backend/gateway/tests/e2e/ledger.e2e.test.ts: escrow ->
# commit -> quarantine -> release -> authorise -> settle, block hash = block N+1 previous_hash, and an
# outbox that drains in order after the auditor peer was down) -> the auditor peer returns the records
# -> down. Prints LEDGER E2E PASS; on failure names the step. It refuses to touch a network it did not
# create. KEEP_NETWORK=1 keeps its own network after a failure. Needs Node >= 22.12 and npm ci in
# backend/gateway.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPTS/env.sh"
CC_DIR="$(cd "$NETWORK_DIR/../chaincode" && pwd)"
GATEWAY_DIR="$(cd "$NETWORK_DIR/../../backend/gateway" && pwd)"
PG_NAME=salesmesh-ledger-e2e-pg
PG_PORT="${LEDGER_E2E_PG_PORT:-55439}"

STEP=init
OWN_NETWORK=0
IDS="$(mktemp)"
step() { STEP=$1; log "[ledger] $1"; }
on_exit() {
  local rc=$?
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  rm -f "$IDS"
  if (( rc != 0 )); then
    echo "LEDGER E2E FAIL at step: $STEP (exit $rc)" >&2
    if (( OWN_NETWORK )) && [[ ${KEEP_NETWORK:-0} != 1 ]]; then
      bash "$SCRIPTS/network_down.sh" >/dev/null 2>&1 || true
    fi
  fi
}
trap on_exit EXIT

# Same helpers as commission_e2e.sh: query <org> <user> <fn> <arg> on that org's peer.
ccargs() { printf '{"Args":["%s","%s"]}' "$1" "${2//\"/\\\"}"; }
query() { peer_cli "$1" "$2" chaincode query -C "$CHANNEL_NAME" -n commission -c "$(ccargs "$3" "$4")" 2>&1 | tr -d '\r'; }
expect() { [[ $1 == *"$2"* ]] || die "$3: expected $2 in: $1"; }
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }   # Node on Windows needs C:/...

require_docker
command -v node >/dev/null 2>&1 || die "node not found (Node >= 22.12 runs the gateway suite)"
[[ -d "$GATEWAY_DIR/node_modules" ]] || die "run npm ci in backend/gateway first"
network_exists && die "existing or partial network found; e2e will not touch it (run network_down.sh first)"

step "postgres"
docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD=pg -p "127.0.0.1:$PG_PORT:5432" postgres:16 >/dev/null
wait_for "$PG_NAME" docker exec "$PG_NAME" pg_isready -U postgres -h 127.0.0.1

step "network up"
OWN_NETWORK=1
bash "$SCRIPTS/network_up.sh"
load_env

step "deploy commission v1.0 seq 1"
bash "$SCRIPTS/deploy_chaincode.sh" commission "$CC_DIR" 1.0 1

step "gateway ledger e2e suite"
(
  cd "$GATEWAY_DIR"
  LEDGER_E2E=1 LEDGER_E2E_IDS="$(hostpath "$IDS")" \
  FABRIC_ORG_DIR="$(hostpath "$NETWORK_DIR/organizations/peerOrganizations/merchant.$DOMAIN")" \
  FABRIC_CHANNEL="$CHANNEL_NAME" \
  TEST_DATABASE_URL="postgres://postgres:pg@127.0.0.1:$PG_PORT/postgres" \
  NODE_OPTIONS=--experimental-vm-modules \
  npx jest --runInBand --coverage=false --forceExit tests/e2e/ledger.e2e.test.ts
)

step "auditor peer returns the records"
mapfile -t ids < <(tr -d '\r' <"$IDS")
(( ${#ids[@]} == 3 )) || die "the suite did not record its escrow / payout ids"
expect "$(query auditor auditor1 GetEscrow "${ids[0]}")" '"status":"HELD"' "released escrow on the auditor peer"
expect "$(query auditor auditor1 GetEscrow "${ids[1]}")" '"status":"RELEASED"' "paid escrow on the auditor peer"
expect "$(query auditor auditor1 GetPayout "${ids[2]}")" '"status":"PAID"' "payout on the auditor peer"

step "network down"
bash "$SCRIPTS/network_down.sh"
OWN_NETWORK=0

echo "LEDGER E2E PASS"
