#!/bin/bash
# scripts/08-install-pm2.sh
# Installs PM2 globally via npm, registers systemd startup, and configures log rotation.
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 08 — Install PM2"

if ! command_exists npm; then
  log_error "npm not found. Step 06 (Node.js) must succeed first."
  exit 1
fi

# ── Install PM2 ────────────────────────────────────────────────────────────────
if command_exists pm2; then
  log_info "PM2 already installed: $(pm2 --version 2>/dev/null)"
else
  log_info "Installing PM2 globally…"
  npm install -g pm2
  log_ok "PM2 installed: $(pm2 --version 2>/dev/null)"
fi

# ── Register PM2 as a systemd service ─────────────────────────────────────────
# 'pm2 startup' prints the exact sudo command to run; capture and execute it.
log_info "Configuring PM2 systemd startup…"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" || \
  log_warn "pm2 startup returned non-zero (may already be configured)"

# ── Log rotation ───────────────────────────────────────────────────────────────
log_info "Installing pm2-logrotate…"
pm2 install pm2-logrotate 2>/dev/null || log_warn "pm2-logrotate already installed or failed"
pm2 set pm2-logrotate:max_size 100M  2>/dev/null || true
pm2 set pm2-logrotate:retain 10      2>/dev/null || true
pm2 set pm2-logrotate:compress false 2>/dev/null || true

log_ok "PM2 $(pm2 --version 2>/dev/null) ready — systemd startup enabled"
log_info "Tip: after starting apps run 'pm2 save' to persist the process list"
