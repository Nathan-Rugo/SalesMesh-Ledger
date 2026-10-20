#!/usr/bin/env bash
# End-to-end testnet check: up -> channel/anchors/discovery -> CCaaS deploy -> endorsers -> 2-org invoke
# -> cross-org query -> identity attrs -> host mTLS endpoint -> secret-leak guard -> down.
# Prints SMOKE PASS; on failure names the step and exits non-zero.
# It refuses to touch a network it did not create. KEEP_NETWORK=1 keeps its own network after a failure.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPTS/env.sh"

STEP=init
OWN_NETWORK=0   # tear down on failure only what this run created
step() { STEP=$1; log "[smoke] $1"; }
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    echo "SMOKE FAIL at step: $STEP (exit $rc)" >&2
    if (( OWN_NETWORK )) && [[ ${KEEP_NETWORK:-0} != 1 ]]; then
      bash "$SCRIPTS/network_down.sh" >/dev/null 2>&1 || true
    fi
  fi
}
trap on_exit EXIT

require_docker
network_exists && die "existing or partial network found; smoke will not touch it (run network_down.sh first)"

step "build smoke chaincode image"   # before any readiness clock starts
ef=.env; [[ -f $ef ]] || ef=.env.example   # .env may not exist until network_up generates it
GOLANG_IMAGE=$(grep '^GOLANG_IMAGE=' "$ef" | cut -d= -f2 | tr -d '\r')
(cd smoke-chaincode && docker build -q -t salesmesh-cc-smoke:1.0 --build-arg GOLANG_IMAGE="$GOLANG_IMAGE" . >/dev/null)

step "network up"
OWN_NETWORK=1   # set before up so a partial up is cleaned too
bash "$SCRIPTS/network_up.sh"
load_env

step "anchor peers in channel config"
# shellcheck disable=SC2046
out=$(peer_cli merchant Admin channel fetch config /channel-artifacts/config.pb -c "$CHANNEL_NAME" \
  $(orderer_flags merchant Admin) 2>&1) || die "channel fetch config failed: $out"
anchors=$(cli sh -c 'configtxlator proto_decode --input /channel-artifacts/config.pb --type common.Block \
  | jq -r ".data.data[0].payload.data.config.channel_group.groups.Application.groups[]
           .values.AnchorPeers.value.anchor_peers[] | \"\(.host):\(.port)\""' | tr -d '\r' | sort | tr '\n' ' ')
[[ $anchors == "peer0.auditor.$DOMAIN:9051 peer0.merchant.$DOMAIN:7051 " ]] || die "anchor peers wrong: '$anchors'"

G=$(user_dir merchant gateway)
discover() { # <subcommand> [args]: service discovery from the merchant peer, as gateway
  cli discover "$@" --channel "$CHANNEL_NAME" --server "$(org_peer merchant)" \
    --peerTLSCA "$(peer_tls_ca merchant)" --MSP MerchantMSP \
    --userCert "$G/msp/signcerts/cert.pem" --userKey "$G/msp/keystore/key.pem" \
    --tlsCert "$G/tls/client.crt" --tlsKey "$G/tls/client.key"
}
has_both() { local o; o=$("$@") && grep -q "$A" <<<"$o" && grep -q "$B" <<<"$o"; }

step "discovery from merchant peer lists both orgs"
A="peer0.merchant.$DOMAIN:7051" B="peer0.auditor.$DOMAIN:9051"
wait_for peer0.merchant.$DOMAIN has_both discover peers   # gossip needs a few seconds to converge

step "deploy smoke chaincode (CCaaS)"
bash "$SCRIPTS/deploy_chaincode.sh" smoke "$NETWORK_DIR/smoke-chaincode" 1.0 1

step "discover endorsers for smoke needs MerchantMSP + AuditorMSP"
A='"MerchantMSP"' B='"AuditorMSP"'
wait_for peer0.merchant.$DOMAIN has_both discover endorsers --chaincode smoke

VALUE="smoke-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"

step "invoke put endorsed by merchant only is rejected (MAJORITY needs both orgs)"
# shellcheck disable=SC2046
out=$(peer_cli merchant gateway chaincode invoke $(orderer_flags merchant gateway) -C "$CHANNEL_NAME" -n smoke \
  --peerAddresses "$(org_peer merchant)" --tlsRootCertFiles "$(peer_tls_ca merchant)" \
  -c '{"Args":["put","lonely","x"]}' --waitForEvent 2>&1) && die "single-org endorsement was accepted"
grep -q ENDORSEMENT_POLICY_FAILURE <<<"$out" || die "single-org invoke failed for the wrong reason: $out"
out=$(peer_cli merchant gateway chaincode query -C "$CHANNEL_NAME" -n smoke -c '{"Args":["get","lonely"]}' 2>&1) \
  && die "rejected write is visible in state: $out"
grep -q "key not found" <<<"$out" || die "get lonely failed for the wrong reason: $out"

step "invoke put endorsed by merchant + auditor (as gateway)"
# shellcheck disable=SC2046
out=$(peer_cli merchant gateway chaincode invoke $(orderer_flags merchant gateway) $(both_peers_flags) \
  -C "$CHANNEL_NAME" -n smoke -c "{\"Args\":[\"put\",\"smoke-key\",\"$VALUE\"]}" --waitForEvent 2>&1) \
  || die "two-org invoke failed: $out"

step "query get on the auditor peer (as auditor1)"
got=$(peer_cli auditor auditor1 chaincode query -C "$CHANNEL_NAME" -n smoke -c '{"Args":["get","smoke-key"]}' | tr -d '\r')
[[ $got == "$VALUE" ]] || die "auditor peer returned '$got', expected '$VALUE'"

step "gateway/auditor1 ecerts carry role attribute"
has_role() { # <cert path> <role>: Fabric CA puts attrs as JSON in a cert extension
  cli sh -c 'sed "1d;\$d" "$1" | base64 -d | grep -aq "\"role\":\"$2\""' sh "$1" "$2"
}
has_role "$G/msp/signcerts/cert.pem" gateway || die "gateway ecert lacks role=gateway"
has_role "$(user_dir auditor auditor1)/msp/signcerts/cert.pem" auditor || die "auditor1 ecert lacks role=auditor"

step "host mTLS to 127.0.0.1:7051 with the #10 gateway files"
command -v openssl >/dev/null 2>&1 || die "openssl not found on host"
M=organizations/peerOrganizations/merchant.$DOMAIN   # relative host paths: no MSYS conversion involved
# -alpn h2: the peer is a gRPC server and expects HTTP/2 negotiation
out=$(openssl s_client -connect 127.0.0.1:7051 -alpn h2 -CAfile "$M/peers/peer0.merchant.$DOMAIN/tls/ca.crt" \
  -cert "$M/users/gateway@merchant.$DOMAIN/tls/client.crt" -key "$M/users/gateway@merchant.$DOMAIN/tls/client.key" \
  -verify_ip 127.0.0.1 -verify_return_error </dev/null 2>&1 | tr -d '\0') || die "host mTLS handshake failed: $out"
grep -q "Verify return code: 0" <<<"$out" || die "host mTLS verification failed: $out"

step "no generated files visible to git"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  leaked=$(git status --porcelain --untracked-files=all . | grep -E 'organizations/|channel-artifacts/|packages/|\.env$|\.(pem|key|crt|block|pb)$' || true)
  [[ -z $leaked ]] || die "generated files visible to git:"$'\n'"$leaked"
fi

step "network down"
bash "$SCRIPTS/network_down.sh"
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")$(docker ps -aq --filter label=salesmesh.fabric=chaincode)" ]] \
  || die "Fabric containers still present after down"
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]] || die "Fabric volumes still present after down"
for d in organizations channel-artifacts packages; do [[ ! -e $d ]] || die "$d/ still present after down"; done
OWN_NETWORK=0

echo "SMOKE PASS"
