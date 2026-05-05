#!/bin/bash
# scripts/04-install-timescaledb.sh
# Installs TimescaleDB Community edition for the active PostgreSQL version,
# configures shared_preload_libraries, and validates the extension.
#
# CRITICAL / FRAGILE STEP — This script has several known failure points:
#   1. The packagecloud.io repo script can fail on transient network errors
#      → wrapped in retry logic
#   2. apt-get install for timescaledb can fail if the PGDG repo isn't ready
#      → waits for PostgreSQL to be running before apt steps
#   3. shared_preload_libraries may already contain timescaledb
#      → idempotent check before ALTER SYSTEM
#   4. The PGDG repo setup script may complain if already installed
#      → handled with || true guards
#
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

PG_VERSION="${PG_VERSION:-17}"

log_section "Step 04 — Install TimescaleDB (PostgreSQL ${PG_VERSION})"

# ── Verify PostgreSQL is running before we touch it ───────────────────────────
log_info "Verifying PostgreSQL ${PG_VERSION} is running…"
if ! service_active postgresql; then
  log_error "PostgreSQL is not active. Run step 03 first."
  exit 1
fi

# ── Check if TimescaleDB package is already installed ─────────────────────────
TSDB_PKG="timescaledb-2-postgresql-${PG_VERSION}"
if dpkg -s "$TSDB_PKG" &>/dev/null; then
  log_info "TimescaleDB package '${TSDB_PKG}' is already installed — skipping apt steps"
else
  # ── Prerequisites ────────────────────────────────────────────────────────────
  log_info "Installing prerequisites…"
  apt_retry 3 install -y gnupg postgresql-common apt-transport-https lsb-release wget curl

  # ── Ensure PGDG setup script has been run (required by TimescaleDB) ──────────
  PGDG_KEY="/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"
  if [[ ! -f "$PGDG_KEY" ]]; then
    log_info "Running PGDG setup script (required by timescaledb)…"
    # Non-interactive mode: pass 'y' to the prompt
    echo 'y' | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh 2>/dev/null || \
      log_warn "PGDG setup script exited non-zero (may already be configured)"
  else
    log_info "PGDG key already present — skipping PGDG setup"
  fi

  # ── Add TimescaleDB apt repository (packagecloud.io) ─────────────────────────
  TSDB_LIST="/etc/apt/sources.list.d/timescale_timescaledb.list"
  if [[ -f "$TSDB_LIST" ]]; then
    log_info "TimescaleDB apt repository already configured"
  else
    log_info "Adding TimescaleDB apt repository (packagecloud.io)…"

    local_attempt=0
    local_max=3
    while (( local_attempt < local_max )); do
      (( local_attempt++ )) || true
      if curl -s https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh \
           | bash; then
        log_ok "TimescaleDB repository added"
        break
      fi
      if (( local_attempt < local_max )); then
        log_warn "Repository script failed (attempt ${local_attempt}/${local_max}) — retrying in 15s…"
        sleep 15
      else
        log_error "Failed to add TimescaleDB repository after ${local_max} attempts."
        exit 1
      fi
    done
  fi

  # ── Install TimescaleDB package ───────────────────────────────────────────────
  log_info "Installing ${TSDB_PKG}…"
  apt-get update -y
  apt_retry 3 install -y "$TSDB_PKG"
  log_ok "Package '${TSDB_PKG}' installed"
fi

# ── Configure shared_preload_libraries ────────────────────────────────────────
log_info "Checking shared_preload_libraries in PostgreSQL…"
CURRENT_PRELOAD="$(sudo -u postgres psql -Atqc "SHOW shared_preload_libraries;" 2>/dev/null || true)"

if [[ "$CURRENT_PRELOAD" == *timescaledb* ]]; then
  log_info "timescaledb is already in shared_preload_libraries — no change needed"
else
  if [[ -n "$CURRENT_PRELOAD" ]]; then
    NEW_PRELOAD="${CURRENT_PRELOAD},timescaledb"
  else
    NEW_PRELOAD="timescaledb"
  fi

  log_info "Setting shared_preload_libraries='${NEW_PRELOAD}'…"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
    -c "ALTER SYSTEM SET shared_preload_libraries = '${NEW_PRELOAD}';"

  log_info "Restarting PostgreSQL to apply shared_preload_libraries…"
  systemctl restart postgresql

  # Wait up to 30 seconds for PostgreSQL to come back
  local_waited=0
  until service_active postgresql || (( local_waited >= 30 )); do
    sleep 2
    (( local_waited += 2 )) || true
  done

  if ! service_active postgresql; then
    log_error "PostgreSQL did not restart cleanly after configuring timescaledb."
    exit 1
  fi
  log_ok "PostgreSQL restarted successfully"
fi

# ── Ensure timescaledb extension exists in template1 and postgres databases ────
log_info "Creating timescaledb extension if not already present…"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" 2>/dev/null || \
  log_warn "Could not create timescaledb extension in 'postgres' database (may already exist)"

# ── Verify extension is visible ───────────────────────────────────────────────
TSDB_VERSION="$(sudo -u postgres psql -Atqc \
  "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';" \
  2>/dev/null || true)"

if [[ -n "$TSDB_VERSION" ]]; then
  log_ok "TimescaleDB extension verified: version ${TSDB_VERSION}"
else
  log_warn "TimescaleDB extension not found in pg_extension — check PostgreSQL logs"
fi

log_ok "Step 04 complete — TimescaleDB ${TSDB_VERSION:-installed} on PostgreSQL ${PG_VERSION}"
