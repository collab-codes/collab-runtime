#!/bin/bash
# scripts/09-install-certbot.sh
# Installs Certbot (Let's Encrypt client) via snap — the method recommended by
# the Certbot project — so NGINX sites can get/renew SSL certificates.
# Idempotent: skips if certbot is already installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 09 — Install Certbot"

if command_exists certbot; then
  log_ok "Certbot already installed: $(certbot --version 2>&1)"
  exit 0
fi

# Certbot's recommended install path is via snap. Ensure snapd is present first.
if ! command_exists snap; then
  log_info "snapd not found — installing…"
  apt_update_safe
  apt_retry 3 install -y snapd
  systemctl enable --now snapd.socket 2>/dev/null || true
fi

# Keep the snap base up to date (recommended by Certbot docs).
log_info "Preparing snap core…"
snap install core 2>/dev/null || true
snap refresh core 2>/dev/null || true

log_info "Installing certbot via snap (classic)…"
snap install --classic certbot

# Expose certbot on the standard PATH (snap installs binaries under /snap/bin).
if [[ ! -e /usr/bin/certbot ]]; then
  ln -s /snap/bin/certbot /usr/bin/certbot
  log_info "Linked /snap/bin/certbot → /usr/bin/certbot"
fi

CERTBOT_BIN="$(command -v certbot || echo /snap/bin/certbot)"
if [[ -x "$CERTBOT_BIN" ]]; then
  log_ok "Certbot installed: $("$CERTBOT_BIN" --version 2>&1)"
else
  log_error "Certbot installation could not be verified"
  exit 1
fi
