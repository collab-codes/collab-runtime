#!/bin/bash
# scripts/06-install-node.sh
# Installs Node.js via the official NodeSource binary package.
# Does NOT use nvm — installs system-wide so pm2 and other tools see it.
# NODE_VERSION is sourced from the active profile (default: 24).
# Idempotent: skips NodeSource setup if the correct version is already installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

NODE_VERSION="${NODE_VERSION:-24}"

log_section "Step 06 — Install Node.js ${NODE_VERSION}.x"

# Check if the correct major version is already installed
if command_exists node; then
  CURRENT_MAJOR="$(node --version | sed 's/v//' | cut -d. -f1)"
  if [[ "$CURRENT_MAJOR" == "$NODE_VERSION" ]]; then
    log_info "Node.js ${NODE_VERSION}.x already installed: $(node --version)"
    log_info "npm: $(npm --version)"
    exit 0
  else
    log_info "Found Node.js v${CURRENT_MAJOR} — replacing with v${NODE_VERSION}…"
  fi
fi

log_info "Adding NodeSource repository for Node.js ${NODE_VERSION}.x…"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -

log_info "Installing nodejs…"
apt_retry 3 install -y nodejs

NODE_VER="$(node --version)"
NPM_VER="$(npm --version)"
log_ok "Node.js installed: ${NODE_VER} | npm: ${NPM_VER}"
