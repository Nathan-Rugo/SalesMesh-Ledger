#!/usr/bin/env bash
# Tear the testnet down completely: chaincode containers, compose services, volumes, generated crypto/artifacts.
# Idempotent; .env (secrets) is kept so the next up reuses it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

require_docker

ids=$(docker ps -aq --filter label=salesmesh.fabric=chaincode)
[[ -z $ids ]] || docker rm -f $ids >/dev/null

# Files written by containers can be root-owned on Linux, so delete them from a container first.
if [[ -d organizations || -d channel-artifacts || -d packages ]]; then
  compose run --rm -T --no-deps --entrypoint sh cli -c 'rm -rf /organizations/* /channel-artifacts/* /packages/*'
fi
compose --profile tools down -v --remove-orphans
rm -rf organizations channel-artifacts packages

log "network down"
