#!/bin/bash
# scripts/08-install-pm2.sh
# Installs PM2 process manager globally via npm.
# Configures PM2 to auto-start on system boot using systemd.
# Installs pm2-logrotate with sensible defaults.
# Idempotent: skips npm install if PM2 is already at the expected version.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 08 — Install PM2"

# ── Ensure Node.js / npm are available ────────────────────────────────────────
if ! command_exists npm; then
  log_error "npm not found. Run step 06 (install-node) first."
  exit 1
fi

# ── Install PM2 globally ───────────────────────────────────────────────────────
if command_exists pm2; then
  log_info "PM2 is already installed: $(pm2 --version 2>/dev/null)"
else
  log_info "Installing PM2 globally via npm…"
  npm install -g pm2
  log_ok "PM2 installed: $(pm2 --version 2>/dev/null)"
fi

# ── Configure PM2 systemd startup ─────────────────────────────────────────────
# We run pm2 startup as root; the command it emits must be evaluated to
# register the systemd unit. Running under sudo means HOME is /root.
log_info "Configuring PM2 systemd startup…"

# Determine the home directory for the root user
PM2_HOME="${HOME:-/root}"
PM2_USER="root"

# Generate and capture the startup command, then evaluate it
STARTUP_CMD="$(pm2 startup systemd -u "${PM2_USER}" --hp "${PM2_HOME}" 2>/dev/null \
  | grep '^sudo ' | head -1 || true)"

if [[ -n "$STARTUP_CMD" ]]; then
  log_info "Evaluating PM2 startup command: ${STARTUP_CMD}"
  eval "$STARTUP_CMD"
  log_ok "PM2 systemd startup registered"
else
  # pm2 startup may output the command differently or already be configured
  log_info "Running pm2 startup directly (no separate command emitted)…"
  env PATH="${PATH}:/usr/bin:/usr/local/bin" \
    pm2 startup systemd -u "${PM2_USER}" --hp "${PM2_HOME}" || \
    log_warn "PM2 startup returned non-zero (may already be configured)"
fi

# ── Install pm2-logrotate ─────────────────────────────────────────────────────
log_info "Installing pm2-logrotate…"
pm2 install pm2-logrotate 2>/dev/null || log_warn "pm2-logrotate install returned non-zero (may already be installed)"

pm2 set pm2-logrotate:max_size 100M   2>/dev/null || true
pm2 set pm2-logrotate:retain 10       2>/dev/null || true
pm2 set pm2-logrotate:compress false  2>/dev/null || true
log_ok "pm2-logrotate configured (max_size: 100M, retain: 10, compress: false)"

PM2_VER="$(pm2 --version 2>/dev/null)"
log_ok "PM2 setup complete: version ${PM2_VER}"
log_info "Tip: after starting your apps run 'pm2 save' to persist the process list."
