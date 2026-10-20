# Shared settings and helpers. Source it; it cds to blockchain/network so compose bind paths stay relative.
# shellcheck shell=bash
set -euo pipefail

NETWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NETWORK_DIR"
export MSYS_NO_PATHCONV=1   # Git Bash: never rewrite /organizations/... container paths

READY_TIMEOUT="${READY_TIMEOUT:-60}"
PROJECT=salesmesh-fabric
DOMAIN=salesmesh.test
ORDERER_ADDR=orderer.$DOMAIN:7050
ORDERER_ADMIN_ADDR=orderer.$DOMAIN:7053
ORDERER_ORG=/organizations/ordererOrganizations/$DOMAIN
ORDERER_TLS_CA=$ORDERER_ORG/msp/tlscacerts/ca.pem

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker daemon not reachable (docker CLI not found)"
  docker info >/dev/null 2>&1 || die "Docker daemon not reachable; start Docker and retry"
}

# Missing .env (e.g. down after a manual delete) falls back to the example so image tags still resolve.
compose() {
  local ef=.env
  [[ -f .env ]] || ef=.env.example
  docker compose --progress quiet --env-file "$ef" -f docker-compose-fabric.yml "$@"
}

load_env() {
  [[ -f .env ]] || die ".env missing; run network_up.sh"
  set -a; . ./.env; set +a
  local k   # an older .env may predate keys added to .env.example
  for k in $(grep -oE '^[A-Za-z0-9_]+=' .env.example | tr -d =); do
    [[ -n ${!k+x} ]] || die ".env lacks $k (new in .env.example): add it to .env, or delete .env to regenerate"
  done
}

# Any container of the compose project, or leftover generated crypto, counts as an existing network.
network_exists() {
  [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" || -d organizations ]]
}

cli() { compose exec -T cli "$@"; }

# wait_for <container> <cmd...>: poll until cmd succeeds or READY_TIMEOUT elapses.
wait_for() {
  local name=$1; shift
  local deadline=$((SECONDS + READY_TIMEOUT))
  until "$@" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || die "$name not ready after ${READY_TIMEOUT}s; see: docker logs $name"
    sleep 1   # poll interval
  done
}

org_msp()  { case $1 in merchant) echo MerchantMSP ;; auditor) echo AuditorMSP ;; *) die "unknown org $1" ;; esac; }
org_peer() { case $1 in merchant) echo peer0.merchant.$DOMAIN:7051 ;; auditor) echo peer0.auditor.$DOMAIN:9051 ;; *) die "unknown org $1" ;; esac; }
peer_tls_ca() { echo "/organizations/peerOrganizations/$1.$DOMAIN/peers/peer0.$1.$DOMAIN/tls/ca.crt"; }
user_dir()    { echo "/organizations/peerOrganizations/$1.$DOMAIN/users/$2@$1.$DOMAIN"; }

# peer_cli <org> <user> <peer args...>: run the peer CLI as <user> of <org> against that org's peer (mTLS).
peer_cli() {
  local org=$1 user=$2; shift 2
  local u; u=$(user_dir "$org" "$user")
  compose exec -T \
    -e CORE_PEER_LOCALMSPID="$(org_msp "$org")" \
    -e CORE_PEER_ADDRESS="$(org_peer "$org")" \
    -e CORE_PEER_MSPCONFIGPATH="$u/msp" \
    -e CORE_PEER_TLS_ENABLED=true \
    -e CORE_PEER_TLS_ROOTCERT_FILE="$(peer_tls_ca "$org")" \
    -e CORE_PEER_TLS_CLIENTAUTHREQUIRED=true \
    -e CORE_PEER_TLS_CLIENTCERT_FILE="$u/tls/client.crt" \
    -e CORE_PEER_TLS_CLIENTKEY_FILE="$u/tls/client.key" \
    cli peer "$@"
}

# Orderer connection flags for peer commands run as <org> <user> (orderer requires client certs too).
orderer_flags() {
  local u; u=$(user_dir "$1" "$2")
  echo "-o $ORDERER_ADDR --tls --cafile $ORDERER_TLS_CA --clientauth --certfile $u/tls/client.crt --keyfile $u/tls/client.key"
}

# Both peers as endorsement targets (MAJORITY of 2 orgs needs both).
both_peers_flags() {
  echo "--peerAddresses $(org_peer merchant) --tlsRootCertFiles $(peer_tls_ca merchant)" \
       "--peerAddresses $(org_peer auditor) --tlsRootCertFiles $(peer_tls_ca auditor)"
}

osnadmin_cli() {
  local a=$ORDERER_ORG/users/Admin@$DOMAIN/tls
  cli osnadmin channel "$@" -o "$ORDERER_ADMIN_ADDR" --ca-file "$ORDERER_TLS_CA" \
    --client-cert "$a/client.crt" --client-key "$a/client.key"
}

build_cc_image() { # <name> <absolute dir> <version>
  load_env
  (cd "$2" && docker build -q -t "salesmesh-cc-$1:$3" --build-arg GOLANG_IMAGE="$GOLANG_IMAGE" . >/dev/null) \
    || die "chaincode image build failed for $2"
}
