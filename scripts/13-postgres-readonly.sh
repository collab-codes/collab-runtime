#!/bin/bash
# scripts/13-postgres-readonly.sh
# Read-only Postgres role for the draft (rt205): `collab_readonly` can read the app's data and write nothing.
#
# WHY: the draft of the Studio must read the app's real data without being able to change it. `SET TRANSACTION READ ONLY`
# does not hold: the app role `collab` owns the tables and can undo it. Only a role without write permission does.
#
# What it does (idempotent; running it again changes nothing that is already right):
#   1. role `collab_readonly`: LOGIN, NOINHERIT, no superuser/CREATEDB/CREATEROLE, not a member of `collab`.
#   2. its password is generated ON THIS MACHINE the first time and kept in ${PASS_FILE} (root only, outside the
#      repository). A re-run reuses it; it never prints it and never passes it as a command argument.
#   3. in the app database (default `collab_app_test`, the one the apps really use — rt205 s0): CONNECT, USAGE on
#      `public`, SELECT on every table now, and default privileges so tables that `collab` creates LATER (the modules
#      DROP + CREATE them, schemaBootstrap.ts) stay readable. Without the database yet (before the first migrate) it
#      only warns: run it again afterwards.
#   4. DATABASE_URL_READONLY in the runtime .env of each app, pointing to that database. The .env is copied into every
#      release, so the next release carries it (or restart the app).
# It does NOT touch the password of `collab`.
#
#   sudo bash scripts/13-postgres-readonly.sh [<env file> ...]
# Without arguments the .env files are found under ${COLLAB_DATA_ROOT:-/data}: app*/mls-base/.env and mls-base/.env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"

RO_USER="${DB_READONLY_USER:-collab_readonly}"
APP_USER="${DB_APP_USER:-collab}"
RO_DATABASE="${DB_READONLY_DATABASE:-collab_app_test}"
DATA_ROOT="${COLLAB_DATA_ROOT:-/data}"
ETC_DIR="${COLLAB_ETC_DIR:-${DATA_ROOT}/etc}"
PASS_FILE="${ETC_DIR}/postgres-readonly.pass"
ENV_VAR="DATABASE_URL_READONLY"

log_section "Step 13 — Read-only Postgres role (${RO_USER})"

if ! command -v psql >/dev/null 2>&1; then
  log_warn "psql not found — skipping the read-only role (is PostgreSQL installed?)"
  exit 0
fi

_psql_super() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$@"
}

# ── Password: made here once, kept outside the repository ───────────────────────────────────
if [[ -s "$PASS_FILE" ]]; then
  RO_PASSWORD="$(tr -d '\n' < "$PASS_FILE")"
  log_info "password of '${RO_USER}' already in ${PASS_FILE} — reusing it"
else
  RO_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  install -d -m 0755 "$ETC_DIR"
  ( umask 077; printf '%s\n' "$RO_PASSWORD" > "$PASS_FILE" )
  chmod 600 "$PASS_FILE"
  log_ok "password of '${RO_USER}' generated and saved to ${PASS_FILE} (mode 600)"
fi

# ── Role ─────────────────────────────────────────────────────────────────────────────────────
# The SQL goes on stdin: the password never shows up in `ps`.
if _psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${RO_USER}';" | grep -q 1; then
  log_info "role '${RO_USER}' exists — making sure it is still read-only and the password matches"
  verb="ALTER"
else
  log_info "creating role '${RO_USER}'"
  verb="CREATE"
fi
printf '%s ROLE "%s" WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"'"'%s'"'"';\n' \
  "$verb" "$RO_USER" "$RO_PASSWORD" | _psql_super >/dev/null
log_ok "role '${RO_USER}' ready (LOGIN, NOINHERIT, no CREATEDB, not a member of '${APP_USER}')"

# ── Grants in the app database ────────────────────────────────────────────────────────────────
if _psql_super -tAc "SELECT 1 FROM pg_database WHERE datname = '${RO_DATABASE}';" | grep -q 1; then
  _psql_super -d "$RO_DATABASE" >/dev/null <<SQL
GRANT CONNECT ON DATABASE "${RO_DATABASE}" TO "${RO_USER}";
GRANT USAGE ON SCHEMA public TO "${RO_USER}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${RO_USER}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${APP_USER}" IN SCHEMA public GRANT SELECT ON TABLES TO "${RO_USER}";
SQL
  log_ok "'${RO_USER}' can read '${RO_DATABASE}' (SELECT now and on tables '${APP_USER}' creates later)"
else
  log_warn "database '${RO_DATABASE}' does not exist yet — no grants. Run this step again after the first migrate"
fi

# ── DATABASE_URL_READONLY in each app .env ────────────────────────────────────────────────────
env_value() { # $1 = file, $2 = key
  sed -n "s/^$2=//p" "$1" | head -n 1
}

set_env_url() { # $1 = env file
  local file="$1" host port url current tmp
  host="$(env_value "$file" PGHOST)"; host="${host:-127.0.0.1}"
  port="$(env_value "$file" PGPORT)"; port="${port:-5432}"
  url="postgres://${RO_USER}:${RO_PASSWORD}@${host}:${port}/${RO_DATABASE}"
  current="$(env_value "$file" "$ENV_VAR")"
  if [[ "$current" == "$url" ]]; then
    log_info "${file}: ${ENV_VAR} already right"
    return 0
  fi
  tmp="$(mktemp)"
  grep -v "^${ENV_VAR}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$ENV_VAR" "$url" >> "$tmp"
  cat "$tmp" > "$file"   # keeps the owner and the mode of the file
  rm -f "$tmp"
  log_ok "${file}: ${ENV_VAR} set (host ${host}:${port}, database ${RO_DATABASE})"
}

if [[ "$#" -gt 0 ]]; then
  env_files=("$@")
else
  env_files=()
  shopt -s nullglob
  for candidate in "${DATA_ROOT}"/app*/mls-base/.env "${DATA_ROOT}/mls-base/.env"; do
    env_files+=("$candidate")
  done
  shopt -u nullglob
fi

if [[ "${#env_files[@]}" -eq 0 ]]; then
  log_warn "no app .env found under ${DATA_ROOT} — pass the file(s) as arguments"
fi
for env_file in "${env_files[@]}"; do
  if [[ -f "$env_file" ]]; then
    set_env_url "$env_file"
  else
    log_warn "${env_file} not found — skipped"
  fi
done

log_ok "Step 13 done. The next release (or a restart) of each app carries ${ENV_VAR}."
