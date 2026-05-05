#!/bin/bash
# scripts/03-install-postgres.sh
# Installs PostgreSQL using the official PGDG apt repository.
# PG_VERSION is sourced from the active profile (default: 17).
# Idempotent: skips repository setup if already present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

PG_VERSION="${PG_VERSION:-17}"

log_section "Step 03 — Install PostgreSQL ${PG_VERSION}"

# ── Prerequisites ─────────────────────────────────────────────────────────────
log_info "Installing prerequisites (curl, ca-certificates)…"
apt_update_safe
apt_retry 3 install -y curl ca-certificates

# ── PGDG repository ───────────────────────────────────────────────────────────
PGDG_KEY="/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"
PGDG_LIST="/etc/apt/sources.list.d/pgdg.list"

if [[ -f "$PGDG_LIST" ]]; then
  log_info "PGDG apt repository already configured — skipping setup"
else
  log_info "Adding PGDG apt repository…"
  install -d /usr/share/postgresql-common/pgdg

  curl -o "$PGDG_KEY" --fail \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc

  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [signed-by=${PGDG_KEY}] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    > "$PGDG_LIST"

  log_ok "PGDG repository added for ${VERSION_CODENAME}"
fi

# ── Install PostgreSQL ────────────────────────────────────────────────────────
if command_exists psql && psql --version 2>/dev/null | grep -q "${PG_VERSION}"; then
  log_info "PostgreSQL ${PG_VERSION} is already installed: $(psql --version)"
else
  log_info "Installing postgresql-${PG_VERSION}…"
  apt_update_safe
  apt_retry 3 install -y "postgresql-${PG_VERSION}" postgresql-contrib
fi

# ── Enable service ────────────────────────────────────────────────────────────
log_info "Enabling and starting postgresql service…"
systemctl enable postgresql
systemctl start postgresql

PG_VER_STR="$(psql --version)"
PG_STATUS="$(systemctl is-active postgresql)"
log_ok "PostgreSQL installed: ${PG_VER_STR} | status: ${PG_STATUS}"
log_info "Tip: connect with 'sudo -u postgres psql'"
