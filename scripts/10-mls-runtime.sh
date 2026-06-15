#!/bin/bash
# scripts/10-mls-runtime.sh
# Prepare this VM to receive and build mls-base publishes:
#   - rsync   : used by publishMlsBase.sh to copy project sources
#   - pnpm    : enabled via corepack (ships with Node.js) to build on the VM
#   - dir     : /data/mls-base owned by the deploy user, so the publish rsync
#               does not need sudo
# Idempotent: safe to re-run as part of install.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 10 — mls-base runtime prerequisites"

MLS_BASE_DIR="${MLS_BASE_DIR:-/data/mls-base}"
# When invoked through sudo, SUDO_USER is the real login user (the one that will
# rsync from the dev machine). Fall back to root if not run via sudo.
DEPLOY_USER="${SUDO_USER:-root}"

# ── rsync ──────────────────────────────────────────────────────────────────────
if command_exists rsync; then
  log_info "rsync already installed: $(rsync --version | head -1 | awk '{print $3}')"
else
  log_info "Installing rsync…"
  apt_update_safe
  apt_retry 3 install -y rsync
  log_ok "rsync installed"
fi

# ── pnpm via corepack ──────────────────────────────────────────────────────────
if command_exists pnpm; then
  log_info "pnpm already available: $(pnpm --version 2>/dev/null)"
elif command_exists corepack; then
  log_info "Enabling pnpm via corepack…"
  corepack enable
  log_ok "pnpm enabled: $(pnpm --version 2>/dev/null || echo enabled)"
else
  log_warn "corepack not found — ensure the Node.js step (06) ran; pnpm not enabled"
fi

# ── mls-base directory ──────────────────────────────────────────────────────────
ensure_dir "$MLS_BASE_DIR"
chown "${DEPLOY_USER}:" "$MLS_BASE_DIR"
log_ok "${MLS_BASE_DIR} ready (owner: ${DEPLOY_USER})"
