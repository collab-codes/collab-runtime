#!/bin/bash
# scripts/05-install-redis.sh
# Installs Redis from the official Redis apt repository.
# Configures it to start on boot and binds only to localhost by default.
# Idempotent: skips repository setup if already present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 05 — Install Redis"

# ── Add official Redis apt repository ─────────────────────────────────────────
REDIS_KEYRING="/usr/share/keyrings/redis-archive-keyring.gpg"
REDIS_LIST="/etc/apt/sources.list.d/redis.list"

if [[ -f "$REDIS_LIST" ]]; then
  log_info "Redis apt repository already configured — skipping setup"
else
  log_info "Adding official Redis apt repository…"
  curl -fsSL https://packages.redis.io/gpg \
    | gpg --dearmor -o "$REDIS_KEYRING"

  echo "deb [signed-by=${REDIS_KEYRING}] https://packages.redis.io/deb $(lsb_release -cs) main" \
    > "$REDIS_LIST"

  log_ok "Redis repository added"
fi

# ── Install Redis ──────────────────────────────────────────────────────────────
if command_exists redis-server; then
  log_info "Redis is already installed: $(redis-server --version)"
else
  log_info "Installing Redis…"
  apt-get update -y
  apt_retry 3 install -y redis
fi

# ── Enable service ────────────────────────────────────────────────────────────
log_info "Enabling and starting redis-server service…"
systemctl enable redis-server
systemctl start redis-server

REDIS_VER="$(redis-server --version)"
REDIS_STATUS="$(systemctl is-active redis-server)"
log_ok "Redis installed: ${REDIS_VER} | status: ${REDIS_STATUS}"
log_info "Tip: test with 'redis-cli ping' (expected: PONG)"
