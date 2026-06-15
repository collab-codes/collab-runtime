#!/bin/bash
# scripts/10-mls-runtime.sh
# Prepare this VM to receive and build mls-base publishes:
#   - rsync / git : rsync is used by publishMlsBase.sh to copy sources; git is
#                   used to clone the mls-base scaffold
#   - pnpm        : enabled via corepack (ships with Node.js) to build on the VM
#   - checkout    : /data/mls-base cloned from the mls-base repo and owned by the
#                   deploy user, so the publish rsync does not need sudo
# Idempotent: safe to re-run as part of install.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 10 — mls-base runtime prerequisites"

MLS_BASE_DIR="${MLS_BASE_DIR:-/data/mls-base}"
MLS_BASE_REPO="${MLS_BASE_REPO:-https://github.com/expansiva/mls-base}"
# When invoked through sudo, SUDO_USER is the real login user (the one that will
# rsync from the dev machine). Fall back to root if not run via sudo.
DEPLOY_USER="${SUDO_USER:-root}"

# ── rsync + git ─────────────────────────────────────────────────────────────────
if ! command_exists rsync || ! command_exists git; then
  apt_update_safe
fi
for tool in rsync git; do
  if command_exists "$tool"; then
    log_info "${tool} already installed"
  else
    log_info "Installing ${tool}…"
    apt_retry 3 install -y "$tool"
    log_ok "${tool} installed"
  fi
done

# ── pnpm via corepack ────────────────────────────────────────────────────────────
if command_exists pnpm; then
  log_info "pnpm already available: $(pnpm --version 2>/dev/null)"
elif command_exists corepack; then
  log_info "Enabling pnpm via corepack…"
  corepack enable
  log_ok "pnpm enabled: $(pnpm --version 2>/dev/null || echo enabled)"
else
  log_warn "corepack not found — ensure the Node.js step (06) ran; pnpm not enabled"
fi

# ── mls-base checkout ─────────────────────────────────────────────────────────────
ensure_dir "$MLS_BASE_DIR"
chown "${DEPLOY_USER}:" "$MLS_BASE_DIR"
if [[ -d "${MLS_BASE_DIR}/.git" ]]; then
  log_info "mls-base checkout present — pulling latest…"
  sudo -u "$DEPLOY_USER" git -C "$MLS_BASE_DIR" pull --ff-only || log_warn "git pull failed (continuing)"
else
  log_info "Cloning mls-base into ${MLS_BASE_DIR}…"
  sudo -u "$DEPLOY_USER" git clone "$MLS_BASE_REPO" "$MLS_BASE_DIR" || log_warn "git clone failed (continuing)"
fi
chown -R "${DEPLOY_USER}:" "$MLS_BASE_DIR"
log_ok "${MLS_BASE_DIR} ready (owner: ${DEPLOY_USER})"
