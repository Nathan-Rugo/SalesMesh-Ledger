#!/usr/bin/env bash
# End-to-end check of the commission chaincode (#9) on the testnet: up -> deploy v1.0 -> InitLedger ->
# every function as the right role and as a wrong one -> auditor-peer query -> upgrade to v1.1 (state
# survives, old container gone) -> down. Prints COMMISSION E2E PASS; on failure names the step.
# It refuses to touch a network it did not create. KEEP_NETWORK=1 keeps its own network after a failure.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPTS/env.sh"
CC_DIR="$(cd "$NETWORK_DIR/../chaincode" && pwd)"

STEP=init
OWN_NETWORK=0
step() { STEP=$1; log "[commission] $1"; }
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    echo "COMMISSION E2E FAIL at step: $STEP (exit $rc)" >&2
    if (( OWN_NETWORK )) && [[ ${KEEP_NETWORK:-0} != 1 ]]; then
      bash "$SCRIPTS/network_down.sh" >/dev/null 2>&1 || true
    fi
  fi
}
trap on_exit EXIT

ccargs() { printf '{"Args":["%s","%s"]}' "$1" "${2//\"/\\\"}"; }   # args here hold no backslashes

# invoke <org> <user> <fn> <json>: submit endorsed by both orgs as <user>; prints peer output
invoke() {
  # shellcheck disable=SC2046 # flag strings split on purpose (paths have no spaces)
  peer_cli "$1" "$2" chaincode invoke $(orderer_flags "$1" "$2") $(both_peers_flags) -C "$CHANNEL_NAME" \
    -n commission -c "$(ccargs "$3" "$4")" --waitForEvent 2>&1
}
query() { peer_cli "$1" "$2" chaincode query -C "$CHANNEL_NAME" -n commission -c "$(ccargs "$3" "$4")" 2>&1 | tr -d '\r'; }

ok()   { local out; out=$(invoke "$@") || die "$3 as $2 failed: $out"; }
# deny <code> <org> <user> <fn> <json>: the invoke must fail with <code>
deny() {
  local code=$1 out; shift
  out=$(invoke "$@") && die "$3 as $2 was accepted; expected $code"
  grep -q "$code" <<<"$out" || die "$3 as $2 failed without $code: $out"
}
expect() { # <haystack> <needle> <what>
  [[ $1 == *"$2"* ]] || die "$3: expected $2 in: $1"
}

require_docker
network_exists && die "existing or partial network found; e2e will not touch it (run network_down.sh first)"

step "network up"
OWN_NETWORK=1
bash "$SCRIPTS/network_up.sh"
load_env

step "deploy commission v1.0 seq 1"
bash "$SCRIPTS/deploy_chaincode.sh" commission "$CC_DIR" 1.0 1

AGENT=a0000000-0000-4000-8000-000000000001
E1=e0000000-0000-4000-8000-000000000001 E2=e0000000-0000-4000-8000-000000000002
E3=e0000000-0000-4000-8000-000000000003 E4=e0000000-0000-4000-8000-000000000004
P1=f0000000-0000-4000-8000-000000000001 DEST=d0000000-0000-4000-8000-000000000001
rid() { printf 'c0000000-0000-4000-8000-%012d' "$1"; }   # request id n
HEX=$(printf 'a%.0s' {1..64})
PAST=$(date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ)   # due already: claimable at once
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
commit_json() { # <escrowId> <decision>
  printf '{"escrowId":"%s","agentRef":"%s","stateHash":"%s","modelVersion":"risk-1.0","modelSha256":"%s","decision":"%s","failSafe":false,"quarantineReason":"","grossCents":15050,"releaseDueAt":"%s"}' \
    "$1" "$AGENT" "$HEX" "$HEX" "$2" "$PAST"
}

step "writes before InitLedger are refused"
deny NOT_INITIALISED merchant gateway CommitTransaction "$(commit_json "$E1" CLEAR)"

step "InitLedger: auditor refused, gateway accepted"
deny UNAUTHORISED auditor auditor1 InitLedger '{}'
ok merchant gateway InitLedger '{}'

step "CommitTransaction: auditor and role-less admin refused, gateway accepted"
deny UNAUTHORISED auditor auditor1 CommitTransaction "$(commit_json "$E1" CLEAR)"
deny UNAUTHORISED merchant Admin CommitTransaction "$(commit_json "$E1" CLEAR)"
ok merchant gateway CommitTransaction "$(commit_json "$E1" CLEAR)"
ok merchant gateway CommitTransaction "$(commit_json "$E2" CLEAR)"
ok merchant gateway CommitTransaction "$(commit_json "$E3" REVIEW)"
expect "$(query merchant gateway GetEscrow "$E3")" '"status":"QUARANTINED"' "REVIEW escrow"

step "QuarantineEscrow: admin refused, gateway and auditor accepted"
deny UNAUTHORISED merchant Admin QuarantineEscrow "{\"requestId\":\"$(rid 1)\",\"escrowId\":\"$E2\",\"reason\":\"velocity\"}"
ok merchant gateway QuarantineEscrow "{\"requestId\":\"$(rid 2)\",\"escrowId\":\"$E2\",\"reason\":\"velocity\"}"
ok auditor auditor1 QuarantineEscrow "{\"requestId\":\"$(rid 3)\",\"escrowId\":\"$E3\",\"reason\":\"audit\"}"

step "ReleaseEscrow: gateway refused on an auditor lock, auditor and gateway release"
deny LOCKED_BY_AUDITOR merchant gateway ReleaseEscrow "{\"requestId\":\"$(rid 4)\",\"escrowId\":\"$E3\",\"reason\":\"cleared\",\"releaseDueAt\":\"$PAST\"}"
ok auditor auditor1 ReleaseEscrow "{\"requestId\":\"$(rid 5)\",\"escrowId\":\"$E3\",\"reason\":\"cleared\",\"releaseDueAt\":\"$PAST\"}"
ok merchant gateway ReleaseEscrow "{\"requestId\":\"$(rid 6)\",\"escrowId\":\"$E2\",\"reason\":\"rescore_clear\",\"releaseDueAt\":\"$PAST\"}"

AUTH=$(printf '{"payoutId":"%s","agentRef":"%s","escrowIds":["%s","%s","%s"],"grossCents":45150,"carryInCents":0,"carryOutCents":50,"amount":451,"consentDigest":"%s","disclosureVersion":"1","canary":{"status":"HEALTHY","destinationRef":"%s","checkedAt":"%s"}}' \
  "$P1" "$AGENT" "$E1" "$E2" "$E3" "$HEX" "$DEST" "$NOW")
step "AuthorisePayout: auditor refused, stale canary refused, gateway accepted"
deny UNAUTHORISED auditor auditor1 AuthorisePayout "$AUTH"
deny CANARY_NOT_HEALTHY merchant gateway AuthorisePayout "${AUTH/$NOW/2020-01-01T00:00:00Z}"
ok merchant gateway AuthorisePayout "$AUTH"
expect "$(query merchant gateway GetEscrow "$E1")" '"status":"CLAIMED"' "claimed escrow"

step "SettlePayout: auditor refused, gateway accepted"
deny UNAUTHORISED auditor auditor1 SettlePayout "{\"payoutId\":\"$P1\",\"outcome\":\"PAID\"}"
ok merchant gateway SettlePayout "{\"payoutId\":\"$P1\",\"outcome\":\"PAID\"}"

step "reads: admin refused; auditor1 queries the auditor peer"
out=$(query merchant Admin GetEscrow "$E1") && die "GetEscrow as Admin was accepted: $out"
expect "$out" UNAUTHORISED "GetEscrow as Admin"
e1=$(query auditor auditor1 GetEscrow "$E1")
expect "$e1" '"status":"RELEASED"' "escrow on auditor peer"
expect "$(query auditor auditor1 GetPayout "$P1")" '"status":"PAID"' "payout on auditor peer"

step "upgrade to v1.1 seq 2: state survives, old container removed"
bash "$SCRIPTS/deploy_chaincode.sh" commission "$CC_DIR" 1.1 2
[[ -z "$(docker ps -aq --filter name=^commission-v1-0.cc.$DOMAIN\$)" ]] || die "v1.0 chaincode container still present"
[[ -n "$(docker ps -q --filter name=^commission-v1-1.cc.$DOMAIN\$)" ]] || die "v1.1 chaincode container not running"
[[ $(query auditor auditor1 GetEscrow "$E1") == "$e1" ]] || die "escrow changed across the upgrade"
ok merchant gateway CommitTransaction "$(commit_json "$E4" CLEAR)"   # v1.1 endorses writes

step "no generated files visible to git"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  leaked=$(git status --porcelain --untracked-files=all . ../chaincode | grep -E 'organizations/|channel-artifacts/|packages/|\.env$|\.(pem|key|crt|block|pb)$' || true)
  [[ -z $leaked ]] || die "generated files visible to git:"$'\n'"$leaked"
fi

step "network down"
bash "$SCRIPTS/network_down.sh"
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")$(docker ps -aq --filter label=salesmesh.fabric=chaincode)" ]] \
  || die "Fabric containers still present after down"
OWN_NETWORK=0

echo "COMMISSION E2E PASS"
