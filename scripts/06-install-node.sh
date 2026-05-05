#!/bin/bash
# scripts/06-install-node.sh
# Installs Node.js via NodeSource — system-wide, not nvm.
# NODE_VERSION sourced from the active profile (default: 24).
# Idempotent: skips if the correct major version is already installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

NODE_VERSION="${NODE_VERSION:-24}"

log_section "Step 06 — Install Node.js ${NODE_VERSION}.x"

if command_exists node; then
  CURRENT_MAJOR="$(node --version | sed 's/v//' | cut -d. -f1)"
  if (( CURRENT_MAJOR >= NODE_VERSION )); then
    log_info "Node.js $(node --version) already installed (>= ${NODE_VERSION})"
    log_info "npm: $(npm --version)"
    exit 0
  else
    log_info "Found Node.js v${CURRENT_MAJOR} — replacing with v${NODE_VERSION}…"
  fi
fi

# Ensure curl and gnupg are present (required by the NodeSource setup script)
apt-get install -y curl gnupg

log_info "Setting up NodeSource repository for Node.js ${NODE_VERSION}.x…"
# sudo -E is intentional: NodeSource's setup script expects the environment
# variables (HOME, PATH) to be preserved, even when running as root.
curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -

log_info "Installing nodejs…"
apt-get install -y nodejs

NODE_VER="$(node --version)"
NPM_VER="$(npm --version)"
log_ok "Node.js installed: ${NODE_VER} | npm: ${NPM_VER}"
