#!/bin/bash
# scripts/06-install-node.js
# Installs Node.js via NodeSource — system-wide, not nvm.
# NODE_VERSION sourced from the active profile (default: 24).
# Idempotent: skips if the correct major version is already installed.
#
# Note: Ubuntu's built-in nodejs package does NOT include npm.
# NodeSource's package includes npm. We always ensure npm is installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

NODE_VERSION="${NODE_VERSION:-24}"

log_section "Step 06 — Install Node.js ${NODE_VERSION}.x"

# Installs pnpm globally via npm. Idempotent: skips if already present.
ensure_pnpm() {
  if command_exists pnpm; then
    log_info "pnpm $(pnpm --version) already installed"
    return 0
  fi
  log_info "Installing pnpm globally via npm…"
  npm install -g pnpm
  log_ok "pnpm: $(pnpm --version)"
}

if command_exists node; then
  CURRENT_MAJOR="$(node --version | sed 's/v//' | cut -d. -f1)"
  if (( CURRENT_MAJOR >= NODE_VERSION )); then
    log_info "Node.js $(node --version) already installed (major >= ${NODE_VERSION})"
    # Ensure npm is also present (Ubuntu's nodejs package omits it)
    if ! command_exists npm; then
      log_info "npm not found alongside existing Node.js — installing npm…"
      apt_update_safe
      apt-get install -y npm
    fi
    log_info "npm: $(npm --version)"
    ensure_pnpm
    exit 0
  else
    log_info "Found Node.js v${CURRENT_MAJOR} — replacing with v${NODE_VERSION}…"
  fi
fi

# Ensure curl and gnupg are available for the NodeSource setup script
log_info "Installing prerequisites (curl, gnupg)…"
apt_update_safe
apt-get install -y curl gnupg

# Set up NodeSource repository.
# sudo -E is used as NodeSource's setup script expects a preserved environment,
# which is also the approach documented by NodeSource.
log_info "Setting up NodeSource repository for Node.js ${NODE_VERSION}.x…"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -

log_info "Installing nodejs (includes npm)…"
apt-get install -y nodejs

NODE_VER="$(node --version)"
NPM_VER="$(npm --version 2>/dev/null || echo 'not found')"

# Final safety net: if npm is still missing after NodeSource install,
# install it from Ubuntu's repo. This can happen if NodeSource's apt update
# failed and Ubuntu's older nodejs was installed instead.
if ! command_exists npm; then
  log_warn "npm not bundled with installed nodejs — installing npm from Ubuntu repos…"
  apt-get install -y npm
  NPM_VER="$(npm --version)"
fi

ensure_pnpm

log_ok "Node.js installed: ${NODE_VER} | npm: ${NPM_VER} | pnpm: $(pnpm --version)"
