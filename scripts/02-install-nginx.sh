#!/bin/bash
# scripts/02-install-nginx.sh
# Installs NGINX web server and enables it as a system service.
# Opens ports 80 and 443 in UFW firewall if UFW is active.
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 02 — Install NGINX"

if command_exists nginx; then
  log_info "NGINX is already installed: $(nginx -v 2>&1)"
else
  log_info "Installing NGINX from apt…"
  apt-get update -y
  apt_retry 3 install -y nginx
fi

log_info "Enabling and starting NGINX service…"
systemctl enable nginx
systemctl start nginx

# Allow HTTP + HTTPS through UFW if it is available and active
if command_exists ufw; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 'Nginx Full' 2>/dev/null || true
    log_info "UFW: opened 'Nginx Full' (ports 80 and 443)"
  else
    log_info "UFW is installed but not active — skipping firewall rule"
  fi
else
  log_info "UFW not found — skipping firewall rule"
fi

NGINX_VER="$(nginx -v 2>&1)"
NGINX_STATUS="$(systemctl is-active nginx)"
log_ok "NGINX installed: ${NGINX_VER} | status: ${NGINX_STATUS}"
