#!/usr/bin/env bash
# Bring up the SalesMesh Fabric testnet: CAs -> identities -> orderer + peers -> commissionchannel.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

require_docker

network_exists && die "existing or partial network found; run network_down.sh first"
# From here on state is created: on failure, say how to recover (no auto-teardown, so logs survive).
trap 'rc=$?; (( rc == 0 )) || echo "ERROR: up failed; run network_down.sh before retrying" >&2' EXIT

rand() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
if [[ ! -f .env ]]; then
  log "generating .env with random secrets"
  (
    umask 077
    while IFS= read -r line; do
      if [[ $line =~ ^([A-Z0-9_]+_PW)= ]]; then echo "${BASH_REMATCH[1]}=$(rand)"; else echo "$line"; fi
    done < .env.example > .env
  )
  chmod 600 .env 2>/dev/null || true   # best-effort on NTFS
fi
load_env

# Created by us (not by Docker) so they are owned by the host user.
mkdir -p organizations/fabric-ca/{orderer,merchant,auditor} channel-artifacts packages

log "pulling images (missing only)"
compose --profile tools pull --policy missing -q

log "starting CAs"
compose up -d ca.orderer.$DOMAIN ca.merchant.$DOMAIN ca.auditor.$DOMAIN cli
wait_for cli.$DOMAIN cli true
for ca in orderer:9054 merchant:7054 auditor:8054; do
  org=${ca%%:*}; port=${ca##*:}
  wait_for ca.$org.$DOMAIN cli curl -sf --max-time 5 --cacert /organizations/fabric-ca/$org/ca-cert.pem \
    "https://ca.$org.$DOMAIN:$port/cainfo"
done

enroll_org() { # <org> <ca admin pw> <node pw> <admin pw> [client name] [client pw] [client role]
  export CA_ADMIN_PW=$2 NODE_PW=$3 ADMIN_PW=$4 CLIENT_NAME=${5:-} CLIENT_PW=${6:-} CLIENT_ROLE=${7:-}
  local extra=()
  if [[ $(uname -s) == Linux ]]; then
    export HOST_UID; HOST_UID=$(id -u); export HOST_GID; HOST_GID=$(id -g)
    extra=(-e HOST_UID -e HOST_GID)
  fi
  # secrets pass by env name only, never on the command line
  compose run --rm -T --no-deps -e CA_ADMIN_USER -e CA_ADMIN_PW -e NODE_PW -e ADMIN_PW \
    -e CLIENT_NAME -e CLIENT_PW -e CLIENT_ROLE ${extra[@]+"${extra[@]}"} enroller "$1" \
    || die "identity enrollment failed for $1"
}
log "registering and enrolling identities"
enroll_org orderer  "$CA_ORDERER_ADMIN_PW"  "$ORDERER_NODE_PW"  "$ORDERER_ADMIN_PW"
enroll_org merchant "$CA_MERCHANT_ADMIN_PW" "$MERCHANT_PEER_PW" "$MERCHANT_ADMIN_PW" gateway  "$MERCHANT_GATEWAY_PW" gateway
enroll_org auditor  "$CA_AUDITOR_ADMIN_PW"  "$AUDITOR_PEER_PW"  "$AUDITOR_ADMIN_PW"  auditor1 "$AUDITOR_AUDITOR1_PW" auditor

log "creating $CHANNEL_NAME genesis block"
cli configtxgen -profile ChannelUsingRaft -channelID "$CHANNEL_NAME" -configPath /configtx \
  -outputBlock "/channel-artifacts/$CHANNEL_NAME.block" >/dev/null \
  || die "configtxgen failed for configtx/configtx.yaml (see output above)"

log "starting orderer and peers"
compose up -d orderer.$DOMAIN peer0.merchant.$DOMAIN peer0.auditor.$DOMAIN

wait_for orderer.$DOMAIN osnadmin_cli list
osnadmin_cli join --channelID "$CHANNEL_NAME" --config-block "/channel-artifacts/$CHANNEL_NAME.block" >/dev/null \
  || die "orderer failed to join $CHANNEL_NAME; see: docker logs orderer.$DOMAIN"

for org in merchant auditor; do
  wait_for peer0.$org.$DOMAIN peer_cli $org Admin channel list
  peer_cli $org Admin channel join -b "/channel-artifacts/$CHANNEL_NAME.block" >/dev/null \
    || die "peer0.$org failed to join $CHANNEL_NAME; see: docker logs peer0.$org.$DOMAIN"
  # joined once the peer has pulled the genesis block from the orderer
  wait_for peer0.$org.$DOMAIN peer_cli $org Admin channel getinfo -c "$CHANNEL_NAME"
done

log "network up: channel $CHANNEL_NAME joined by orderer, peer0.merchant, peer0.auditor (anchor peers from configtx)"
