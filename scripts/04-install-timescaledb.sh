#!/bin/bash
# scripts/04-install-timescaledb.sh
# Installs TimescaleDB Community (Timescale License) for the active PostgreSQL version.
#
# IMPORTANT — package selection:
#   CORRECT : timescaledb-2-postgresql-17       ← Community (TSL)  — confirmed working
#   WRONG   : timescaledb-2-oss-postgresql-17   ← Apache edition   — license error on load
#   WRONG   : postgresql-17-timescaledb         ← Ubuntu main repo — wrong package, fails
#
# Supported Ubuntu versions for the packagecloud.io repo:
#   focal (20.04), jammy (22.04), noble (24.04)
#   Ubuntu 25.10+ (questing, etc.) → not yet in packagecloud, step is skipped with a warning.
#
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

PG_VERSION="${PG_VERSION:-17}"
TSDB_PKG="timescaledb-2-postgresql-${PG_VERSION}"
TSDB_SUPPORTED_CODENAMES="focal jammy noble"

# Resolve current Ubuntu codename
. /etc/os-release
CODENAME="${VERSION_CODENAME:-unknown}"

log_section "Step 04 — Install TimescaleDB Community (PostgreSQL ${PG_VERSION})"

# ── Verify PostgreSQL is running ───────────────────────────────────────────────
if ! service_active postgresql; then
  log_error "PostgreSQL is not active. Step 03 must succeed first."
  exit 1
fi

# ── Check if this Ubuntu version is supported by TimescaleDB packagecloud ─────
if ! codename_supported "$CODENAME" "$TSDB_SUPPORTED_CODENAMES"; then
  log_warn "TimescaleDB packagecloud repo does not yet support Ubuntu ${CODENAME}"
  log_warn "Supported versions: Ubuntu focal/jammy/noble (20.04, 22.04, 24.04 LTS)"
  log_warn "Skipping TimescaleDB installation — rerun on Ubuntu 24.04 LTS for production"
  log_warn "STEP SKIPPED — not a failure on non-LTS Ubuntu"
  # Exit 0 so the installer does not count this as FAIL on a dev/test machine
  exit 0
fi

# ── Skip apt steps if package is already installed ────────────────────────────
if dpkg -s "$TSDB_PKG" &>/dev/null; then
  log_info "Package '${TSDB_PKG}' already installed — skipping apt steps"
else
  log_info "Installing prerequisites…"
  apt_update_safe
  apt-get install -y gnupg postgresql-common apt-transport-https lsb-release wget

  # Run PGDG setup if the apt source wasn't created by step 03.
  # In non-interactive context (stdout not a TTY) this script auto-proceeds.
  if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
    log_info "Running PGDG apt setup…"
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh || \
      log_warn "PGDG setup returned non-zero (may already be configured)"
  fi

  # Add TimescaleDB apt repository via packagecloud.io
  log_info "Adding TimescaleDB apt repository (packagecloud.io)…"
  local_attempt=0
  while (( local_attempt < 3 )); do
    (( local_attempt++ )) || true
    if curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | bash; then
      log_ok "TimescaleDB repository added"
      break
    fi
    if (( local_attempt < 3 )); then
      log_warn "Repo script failed (attempt ${local_attempt}/3) — retrying in 15s…"
      sleep 15
    else
      log_error "Failed to add TimescaleDB repository after 3 attempts"
      exit 1
    fi
  done

  log_info "Installing ${TSDB_PKG} (Community edition)…"
  apt-get update -y
  apt-get install -y "$TSDB_PKG"
  log_ok "Package '${TSDB_PKG}' installed"
fi

# ── Configure shared_preload_libraries ────────────────────────────────────────
CURRENT_PRELOAD="$(sudo -u postgres psql -Atqc "SHOW shared_preload_libraries;" 2>/dev/null || true)"

if [[ "$CURRENT_PRELOAD" == *timescaledb* ]]; then
  log_info "timescaledb already in shared_preload_libraries"
else
  if [[ -n "$CURRENT_PRELOAD" ]]; then
    NEW_PRELOAD="${CURRENT_PRELOAD},timescaledb"
  else
    NEW_PRELOAD="timescaledb"
  fi
  log_info "Setting shared_preload_libraries='${NEW_PRELOAD}'…"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
    -c "ALTER SYSTEM SET shared_preload_libraries = '${NEW_PRELOAD}';"
  systemctl restart postgresql
fi

systemctl is-active --quiet postgresql
log_ok "PostgreSQL running with timescaledb in shared_preload_libraries"

# ── Enable extension and smoke-test ───────────────────────────────────────────
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"

sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres <<'SQL'
CREATE TABLE IF NOT EXISTS _collab_tsdb_smoke (
  time TIMESTAMPTZ NOT NULL,
  val  DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('_collab_tsdb_smoke', 'time', if_not_exists => TRUE);
INSERT INTO _collab_tsdb_smoke VALUES (NOW(), 1.0);
SELECT 'timescaledb smoke test ok' AS result FROM _collab_tsdb_smoke LIMIT 1;
DROP TABLE _collab_tsdb_smoke;
SQL

TSDB_VER="$(sudo -u postgres psql -Atqc \
  "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';" 2>/dev/null || true)"

log_ok "TimescaleDB Community ${TSDB_VER} verified on PostgreSQL ${PG_VERSION}"
