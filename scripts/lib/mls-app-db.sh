#!/bin/bash
# scripts/lib/mls-app-db.sh
# The application role, the application database and the runtime .env — in ONE place.
#
# WHY THIS FILE EXISTS
# The same three things were written twice, with the same defaults: here (step 10) and in
# mls-base/scripts/vmInitialSetup.sh, which the traditional publish runs over ssh with
# --initial. Two copies of one rule means a fix lands in one and misses the other. Now both
# callers source this file:
#
#   • collab-runtime scripts/10-mls-runtime.sh  — the VM bootstrap
#   • mls-base scripts/vmInitialSetup.sh        — first-time setup over ssh (lima)
#
# Sourceable, not runnable: it only defines functions. Each is idempotent, and each says
# what it did.
#
# NO DEPENDENCY ON logger.sh: the functions below are defined only when the caller has not
# already provided them. Under install.sh the real logger wins; standalone (over ssh, no
# /var/log/collab, no root) it prints plainly instead of failing on a missing log dir.

DB_APP_USER="${DB_APP_USER:-collab}"
DB_APP_PASSWORD="${DB_APP_PASSWORD:-collab}"
DB_APP_DATABASE="${DB_APP_DATABASE:-mdm}"

if ! declare -F log_info >/dev/null 2>&1; then
  log_info() { echo "--- $*"; }
fi
if ! declare -F log_ok >/dev/null 2>&1; then
  log_ok() { echo "    $*"; }
fi
if ! declare -F log_warn >/dev/null 2>&1; then
  log_warn() { echo "!!! $*" >&2; }
fi
if ! declare -F command_exists >/dev/null 2>&1; then
  command_exists() { command -v "$1" >/dev/null 2>&1; }
fi

_psql_super() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
}

# The role the collab apps connect as. On the bootstrap path 03-install-postgres.sh already
# created it; over ssh (lima) nothing did, and `CREATE DATABASE ... OWNER` would fail.
ensure_app_role() {
  if ! command_exists psql; then
    log_warn "psql not found — skipping role '${DB_APP_USER}' (is PostgreSQL installed?)"
    return 0
  fi
  log_info "role '${DB_APP_USER}'"
  if _psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_APP_USER}';" | grep -q 1; then
    log_ok "already exists"
    return 0
  fi
  _psql_super -c "CREATE ROLE \"${DB_APP_USER}\" WITH LOGIN PASSWORD '${DB_APP_PASSWORD}' CREATEDB;"
  log_ok "created"
}

# migrate.js creates TABLES but not the database itself, and the timescaledb extension is
# per-database and superuser-only (the app cannot enable it at runtime — hypertables need it).
ensure_app_database() {
  if ! command_exists psql; then
    log_warn "psql not found — skipping database creation (run the PostgreSQL step first)"
    return 0
  fi
  log_info "database '${DB_APP_DATABASE}'"
  if _psql_super -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_APP_DATABASE}';" | grep -q 1; then
    log_ok "already exists"
  else
    _psql_super -c "CREATE DATABASE \"${DB_APP_DATABASE}\" OWNER \"${DB_APP_USER}\";"
    log_ok "created (owner '${DB_APP_USER}')"
  fi
  log_info "timescaledb extension on '${DB_APP_DATABASE}'"
  if _psql_super -d "${DB_APP_DATABASE}" -c 'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;' >/dev/null; then
    log_ok "enabled"
  else
    log_warn "timescaledb extension not enabled (did the TimescaleDB step run?) — hypertables fall back to regular tables"
  fi
}

# The runtime .env, stable at the mls-base root: addNewVersion.mjs copies it into every
# release (the server and migrate resolve .env from their cwd). Without it the app falls back
# to APP_ENV=development + RUNTIME_MODE=memory and never touches Postgres.
#
# $1 = mls-base root, $2 = user to own the file (optional).
ensure_mls_env() {
  local mls_base_dir="$1"
  local owner="${2:-}"
  local env_file="${mls_base_dir}/.env"

  log_info ".env at ${env_file}"
  if [[ -f "$env_file" ]]; then
    log_ok "already present — left untouched"
    return 0
  fi
  cat > "$env_file" <<EOF
APP_ENV=production
RUNTIME_MODE=postgres
PORT=3000
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=${DB_APP_DATABASE}
PGUSER=${DB_APP_USER}
PGPASSWORD=${DB_APP_PASSWORD}
# Local VM has no AWS/DynamoDB: keep the write-behind worker off.
WRITE_BEHIND_ENABLED=false
EOF
  if [[ -n "$owner" ]]; then chown "${owner}:" "$env_file" 2>/dev/null || true; fi
  log_ok "created (production runtime, postgres as '${DB_APP_USER}')"
}
