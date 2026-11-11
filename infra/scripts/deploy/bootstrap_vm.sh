#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VM (docs/architecture/deployment.md). Safe to re-run: every
# step checks first. Run as the login user (it uses sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/Nathan-Rugo/SalesMesh-Ledger/main/infra/scripts/deploy/bootstrap_vm.sh | bash
#   # or, from a checkout: bash infra/scripts/deploy/bootstrap_vm.sh
#
# Installs Docker Engine + the compose plugin (Docker's apt repo), Node 24 (the gateway / PWA test
# suites and the ledger e2e run on the host), git, make and openssl; adds a 4 GB swap file; puts the
# user in the docker group; clones REPO_URL (branch BRANCH) into DIR unless it is there already.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/Nathan-Rugo/SalesMesh-Ledger.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-$HOME/SalesMesh-Ledger}"
SWAP_FILE=/swapfile
SWAP_SIZE=4G

log() { echo "bootstrap: $*"; }
[[ $(id -u) -ne 0 ]] || { echo "bootstrap: run as the login user, not root (it uses sudo)" >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || { echo "bootstrap: Ubuntu expected, found ${ID:-unknown}" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
need=()
for p in ca-certificates curl git make openssl gnupg; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if ((${#need[@]})); then
  log "installing ${need[*]}"
  sudo apt-get update -qq && sudo apt-get install -y -qq "${need[@]}"
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  log "installing Docker Engine + compose plugin"
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo systemctl enable --now docker >/dev/null

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  log "added $USER to the docker group: log out and back in (or run 'newgrp docker')"
fi

if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 24 )); then
  # 24, not 22: Jest loads the ESM-only @noble/curves (via fabric-gateway) only on Node >= 24.9.
  log "installing Node 24 (NodeSource apt repo)"
  sudo curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
  sudo chmod a+r /etc/apt/keyrings/nodesource.asc
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main" |
    sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq nodejs
fi

if ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  log "adding a $SWAP_SIZE swap file"
  [[ -f $SWAP_FILE ]] || { sudo fallocate -l "$SWAP_SIZE" "$SWAP_FILE"; sudo chmod 600 "$SWAP_FILE"; sudo mkswap "$SWAP_FILE" >/dev/null; }
  sudo swapon "$SWAP_FILE"
fi
grep -q "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
# Prefer RAM; swap is headroom for builds and spikes, not working memory.
[[ $(cat /proc/sys/vm/swappiness) == 10 ]] || { echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-salesmesh.conf >/dev/null; sudo sysctl -q -p /etc/sysctl.d/99-salesmesh.conf; }

if [[ -d $DIR/.git ]]; then
  log "$DIR already cloned (update it with: git -C $DIR pull)"
else
  log "cloning $REPO_URL ($BRANCH) into $DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

log "done. Next: cd $DIR && bash infra/scripts/deploy/gen_env.sh"
