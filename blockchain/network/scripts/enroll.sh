#!/usr/bin/env bash
# Runs INSIDE the enroller (fabric-ca) container: register + enroll every identity of one org
# from that org's CA. Usage: enroll.sh <orderer|merchant|auditor>
# Secrets come in as env: CA_ADMIN_USER CA_ADMIN_PW NODE_PW ADMIN_PW [CLIENT_NAME CLIENT_PW CLIENT_ROLE]
set -euo pipefail

ORG=${1:?usage: enroll.sh <orderer|merchant|auditor>}
D=salesmesh.test
case $ORG in
  orderer)
    PORT=9054; ORG_DOMAIN=$D; BASE=/organizations/ordererOrganizations/$D
    NODE=orderer.$D; NODE_TYPE=orderer; NODE_DIR=$BASE/orderers/$NODE; NODE_HOSTS=$NODE ;;
  merchant)
    PORT=7054; ORG_DOMAIN=merchant.$D; BASE=/organizations/peerOrganizations/$ORG_DOMAIN
    NODE=peer0.$ORG_DOMAIN; NODE_TYPE=peer; NODE_DIR=$BASE/peers/$NODE
    NODE_HOSTS=$NODE,localhost,127.0.0.1 ;;   # #10 dials 127.0.0.1:7051 from the host
  auditor)
    PORT=8054; ORG_DOMAIN=auditor.$D; BASE=/organizations/peerOrganizations/$ORG_DOMAIN
    NODE=peer0.$ORG_DOMAIN; NODE_TYPE=peer; NODE_DIR=$BASE/peers/$NODE; NODE_HOSTS=$NODE ;;
  *) echo "unknown org: $ORG" >&2; exit 1 ;;
esac

CA_URL_HOST=ca.$ORG.$D:$PORT
CA_NAME=ca-$ORG
CA_ROOT=/organizations/fabric-ca/$ORG/ca-cert.pem   # signs both enrollment and TLS certs (tls profile)
export FABRIC_CA_CLIENT_HOME=$BASE/ca-registrar

ca() { # fabric-ca-client is chatty: show its log only when it fails
  fabric-ca-client "$@" --caname "$CA_NAME" --tls.certfiles "$CA_ROOT" >/tmp/ca.log 2>&1 \
    || { cat /tmp/ca.log >&2; echo "fabric-ca-client $1 failed for $ORG" >&2; exit 1; }
}

# Fixed file names (cacerts/ca.pem, tlscacerts/ca.pem, keystore/key.pem) plus NodeOU config.
normalise_msp() {
  local m=$1
  mkdir -p "$m/cacerts" "$m/tlscacerts"
  rm -f "$m"/cacerts/*
  rm -rf "$m"/tlscacerts/* "$m"/IssuerPublicKey "$m"/IssuerRevocationPublicKey "$m"/user
  cp "$CA_ROOT" "$m/cacerts/ca.pem"
  cp "$CA_ROOT" "$m/tlscacerts/ca.pem"
  for k in "$m"/keystore/*_sk; do [[ -e $k ]] && mv "$k" "$m/keystore/key.pem"; done
  cat > "$m/config.yaml" <<'EOF'
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/ca.pem
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/ca.pem
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/ca.pem
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/ca.pem
    OrganizationalUnitIdentifier: orderer
EOF
}

# enroll_identity <name> <secret> <dir> <server|client> [csr hosts]: msp/ ecert + tls/ pair.
enroll_identity() {
  local name=$1 secret=$2 dir=$3 kind=$4 hosts=${5:-}
  local host_args=()
  [[ -n $hosts ]] && host_args=(--csr.hosts "$hosts")
  ca enroll -u "https://$name:$secret@$CA_URL_HOST" -M "$dir/msp" "${host_args[@]}"
  normalise_msp "$dir/msp"
  ca enroll -u "https://$name:$secret@$CA_URL_HOST" -M "$dir/tls-msp" --enrollment.profile tls "${host_args[@]}"
  mkdir -p "$dir/tls"
  cp "$dir"/tls-msp/signcerts/* "$dir/tls/$kind.crt"
  cp "$dir"/tls-msp/keystore/* "$dir/tls/$kind.key"
  cp "$CA_ROOT" "$dir/tls/ca.crt"
  rm -rf "$dir/tls-msp"
}

echo "enroll: $ORG"
ca enroll -u "https://$CA_ADMIN_USER:$CA_ADMIN_PW@$CA_URL_HOST"

# Org MSP (public material only: what goes into the channel config)
normalise_msp "$BASE/msp"

ca register --id.name "$NODE" --id.secret "$NODE_PW" --id.type "$NODE_TYPE"
enroll_identity "$NODE" "$NODE_PW" "$NODE_DIR" server "$NODE_HOSTS"

ca register --id.name "$ORG-admin" --id.secret "$ADMIN_PW" --id.type admin
enroll_identity "$ORG-admin" "$ADMIN_PW" "$BASE/users/Admin@$ORG_DOMAIN" client

if [[ -n ${CLIENT_NAME:-} ]]; then
  # role is put in the ecert (":ecert") so chaincode (#9) can read it via the client identity attrs
  ca register --id.name "$CLIENT_NAME" --id.secret "$CLIENT_PW" --id.type client \
    --id.attrs "role=$CLIENT_ROLE:ecert"
  enroll_identity "$CLIENT_NAME" "$CLIENT_PW" "$BASE/users/$CLIENT_NAME@$ORG_DOMAIN" client
fi

# Linux: hand the generated files to the host user so #10 can read them (no-op elsewhere).
if [[ -n ${HOST_UID:-} ]]; then
  chown -R "$HOST_UID:$HOST_GID" "$BASE" "/organizations/fabric-ca/$ORG"
fi
