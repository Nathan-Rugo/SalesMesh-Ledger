#!/usr/bin/env bash
# Deploy a chaincode as a service (CCaaS) on commissionchannel.
# Usage: deploy_chaincode.sh <name> <chaincode dir with Dockerfile> [version=1.0] [sequence=1]
# Builds the image, installs the same package on both peers, starts one versioned chaincode container
# that serves both peers, approves for both orgs and commits. On upgrade, older containers of the same
# chaincode are removed only after the new definition is committed.
set -euo pipefail

NAME=${1:?usage: deploy_chaincode.sh <name> <dir> [version] [sequence]}
CC_DIR=$(cd "${2:?usage: deploy_chaincode.sh <name> <dir> [version] [sequence]}" && pwd) \
  || { echo "ERROR: chaincode dir not found: $2" >&2; exit 1; }
VERSION=${3:-1.0}
SEQUENCE=${4:-1}
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[[ $NAME =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "chaincode name must be lowercase letters, digits, hyphens (it becomes a hostname)"
[[ $VERSION =~ ^[A-Za-z0-9][A-Za-z0-9_.+-]*$ ]] || die "version must match ^[A-Za-z0-9][A-Za-z0-9_.+-]*\$"
[[ $SEQUENCE =~ ^[1-9][0-9]*$ ]] || die "sequence must be a positive integer"
[[ -f $CC_DIR/Dockerfile ]] || die "no Dockerfile in $CC_DIR"
require_docker
load_env
[[ -n "$(docker ps -q --filter name=^orderer.$DOMAIN\$)" ]] || die "network not up; run network_up.sh first"

LABEL=${NAME}_${VERSION}
# Hostname label: version lowercased, [._+] -> '-', trailing '-' dropped (smoke 1.0 -> smoke-v1-0).
# shortcut: versions differing only in those chars (1.0 vs 1-0) share a container name; use plain versions.
CC_LABEL=$NAME-v$(tr 'A-Z._+' 'a-z---' <<<"$VERSION" | sed 's/-*$//')
(( ${#CC_LABEL} <= 63 )) || die "name + version too long for a hostname label: $CC_LABEL"
CC_HOST=$CC_LABEL.cc.$DOMAIN
IMAGE=salesmesh-cc-$NAME:$VERSION

log "building $IMAGE"
build_cc_image "$NAME" "$CC_DIR" "$VERSION"

log "packaging $LABEL (ccaas -> $CC_HOST:9999)"
# connection.json is plaintext: peer->chaincode stays inside the Docker network (documented limit).
# Tarballs are reproducible (fixed mtime/owner, gzip -n) so a re-run yields the same package id.
cli bash -c 'set -euo pipefail; d=/packages/$1; rm -rf "$d" "$d.tar.gz"; mkdir -p "$d"; cd "$d"
  t() { tar --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - "$@" | gzip -n; }
  printf "{\"address\":\"%s:9999\",\"dial_timeout\":\"10s\",\"tls_required\":false}" "$2" > connection.json
  printf "{\"type\":\"ccaas\",\"label\":\"%s\"}" "$1" > metadata.json
  t connection.json > code.tar.gz
  t metadata.json code.tar.gz > "$d.tar.gz"' sh "$LABEL" "$CC_HOST"
PKG_ID=$(peer_cli merchant Admin lifecycle chaincode calculatepackageid "/packages/$LABEL.tar.gz") \
  || die "calculatepackageid failed on merchant"
PKG_ID=$(tr -d '\r' <<<"$PKG_ID")
[[ -n $PKG_ID ]] || die "could not compute package id"

for org in merchant auditor; do
  installed=$(peer_cli $org Admin lifecycle chaincode queryinstalled --output json) \
    || die "queryinstalled failed on $org; see: docker logs peer0.$org.$DOMAIN"
  if [[ $installed == *"\"$PKG_ID\""* ]]; then
    log "already installed on peer0.$org"
  else
    log "installing on peer0.$org"
    peer_cli $org Admin lifecycle chaincode install "/packages/$LABEL.tar.gz" >/dev/null \
      || die "install failed on peer0.$org; see: docker logs peer0.$org.$DOMAIN"
  fi
done

log "starting chaincode container $CC_HOST"
docker rm -f "$CC_HOST" >/dev/null 2>&1 || true   # same version redeployed: replace only its own container
docker run -d --name "$CC_HOST" --hostname "$CC_HOST" --network salesmesh_fabric \
  --label salesmesh.fabric=chaincode --label "salesmesh.cc=$NAME" --memory 64m --restart unless-stopped \
  -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 -e CHAINCODE_ID="$PKG_ID" "$IMAGE" >/dev/null

for org in merchant auditor; do
  log "approving for $(org_msp $org)"
  # shellcheck disable=SC2046 # flag strings split on purpose (paths have no spaces)
  peer_cli $org Admin lifecycle chaincode approveformyorg $(orderer_flags $org Admin) \
    --channelID "$CHANNEL_NAME" --name "$NAME" --version "$VERSION" --package-id "$PKG_ID" --sequence "$SEQUENCE" \
    >/dev/null || die "approveformyorg failed for $org (sequence $SEQUENCE already used?)"
done

log "committing $NAME v$VERSION seq $SEQUENCE"
# shellcheck disable=SC2046
peer_cli merchant Admin lifecycle chaincode commit $(orderer_flags merchant Admin) $(both_peers_flags) \
  --channelID "$CHANNEL_NAME" --name "$NAME" --version "$VERSION" --sequence "$SEQUENCE" >/dev/null \
  || die "commit failed for $NAME"
[[ -n "$(docker ps -q --filter "name=^$CC_HOST\$")" ]] || die "chaincode container exited; see: docker logs $CC_HOST"

# The committed definition now points at $CC_HOST: retire older versions' containers.
for id in $(docker ps -aq --filter "label=salesmesh.cc=$NAME"); do
  [[ $(docker inspect -f '{{.Name}}' "$id") == "/$CC_HOST" ]] || docker rm -f "$id" >/dev/null
done

log "deployed $NAME (package $PKG_ID)"
