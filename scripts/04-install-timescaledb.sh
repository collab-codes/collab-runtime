#!/bin/bash
# scripts/04-install-timescaledb.sh
# Installs TimescaleDB Community (Timescale License) for the active PostgreSQL version.
#
# IMPORTANT — package selection:
#   CORRECT : timescaledb-2-postgresql-17       ← Community edition (TSL) — what works
#   WRONG   : timescaledb-2-oss-postgresql-17   ← Apache edition — fails with license error on load
#   WRONG   : postgresql-17-timescaledb         ← Ubuntu default repo — wrong package, fails
#
# This script mirrors configure-postgres-timescale.sh which is the confirmed working approach.
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

PG_VERSION="${PG_VERSION:-17}"
TSDB_PKG="timescaledb-2-postgresql-${PG_VERSION}"

log_section "Step 04 — Install TimescaleDB Community (PostgreSQL ${PG_VERSION})"

# ── Verify PostgreSQL is running ───────────────────────────────────────────────
if ! service_active postgresql; then
  log_error "PostgreSQL is not active. Step 03 must succeed first."
  exit 1
fi

# ── Skip apt steps if package is already installed ────────────────────────────
if dpkg -s "$TSDB_PKG" &>/dev/null; then
  log_info "Package '${TSDB_PKG}' already installed — skipping apt steps"
else
  log_info "Installing prerequisites…"
  apt-get update -y
  apt-get install -y gnupg postgresql-common apt-transport-https lsb-release wget

  # Run the PGDG apt setup script.
  # In non-interactive context (stdout not a TTY) this script proceeds automatically.
  # If the PGDG repo is already configured (step 03 sets it up), it exits gracefully.
  log_info "Running PGDG apt setup (required by timescaledb repo)…"
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh || \
    log_warn "PGDG setup returned non-zero (may already be configured — continuing)"

  # Add the TimescaleDB apt repository via packagecloud.io.
  # Using 'bash' not 'bash -' so the script runs in its own clean context.
  log_info "Adding TimescaleDB apt repository (packagecloud.io)…"
  curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | bash

  log_info "Installing ${TSDB_PKG} (Community edition)…"
  apt-get install -y "$TSDB_PKG"
  log_ok "Package '${TSDB_PKG}' installed"
fi

# ── Configure shared_preload_libraries ────────────────────────────────────────
CURRENT_PRELOAD="$(sudo -u postgres psql -Atqc "SHOW shared_preload_libraries;" 2>/dev/null || true)"

if [[ "$CURRENT_PRELOAD" == *timescaledb* ]]; then
  log_info "timescaledb already in shared_preload_libraries — no change needed"
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
log_ok "PostgreSQL is running with timescaledb in shared_preload_libraries"

# ── Enable TimescaleDB extension and validate ─────────────────────────────────
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"

# Quick write validation (mirrors the working script's smoke test)
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
