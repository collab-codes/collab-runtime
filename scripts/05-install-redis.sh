#!/bin/bash
# scripts/05-install-redis.sh
# Installs Redis from the official packages.redis.io apt repository.
# Falls back to Ubuntu's built-in redis-server for Ubuntu versions not yet
# supported by the official Redis apt repo (e.g. Ubuntu 25.10+).
#
# Official Redis apt repo supported Ubuntu versions: focal, jammy, noble
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

REDIS_SUPPORTED_CODENAMES="focal jammy noble"

. /etc/os-release
CODENAME="${VERSION_CODENAME:-unknown}"

log_section "Step 05 — Install Redis"

if command_exists redis-server; then
  log_info "Redis already installed: $(redis-server --version)"
else
  if codename_supported "$CODENAME" "$REDIS_SUPPORTED_CODENAMES"; then
    # ── Official Redis apt repo ──────────────────────────────────────────────
    REDIS_KEYRING="/usr/share/keyrings/redis-archive-keyring.gpg"
    REDIS_LIST="/etc/apt/sources.list.d/redis.list"

    log_info "Adding official Redis apt repository for Ubuntu ${CODENAME}…"
    curl -fsSL https://packages.redis.io/gpg \
      | gpg --dearmor -o "$REDIS_KEYRING"
    echo "deb [signed-by=${REDIS_KEYRING}] https://packages.redis.io/deb ${CODENAME} main" \
      > "$REDIS_LIST"

    log_info "Installing Redis from official repository…"
    apt-get update -y
    apt-get install -y redis
  else
    # ── Fallback: Ubuntu built-in redis-server ───────────────────────────────
    log_warn "Official Redis apt repo does not yet support Ubuntu ${CODENAME}"
    log_warn "Installing redis-server from Ubuntu's built-in repository instead"
    apt_update_safe
    apt-get install -y redis-server
  fi
fi

# ── Enable and start service ───────────────────────────────────────────────────
systemctl enable redis-server
systemctl start redis-server

REDIS_VER="$(redis-server --version)"
REDIS_STATUS="$(systemctl is-active redis-server)"
log_ok "Redis installed: ${REDIS_VER} | status: ${REDIS_STATUS}"
log_info "Tip: test with 'redis-cli ping' (expected: PONG)"
