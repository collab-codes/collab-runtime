#!/bin/bash
# scripts/14-postgres-cm.sh
# The Postgres of collab-messages (rt231): role + database of the cm, and the `db` block of its appconfig.json.
#
# WHY: the cm reads the `db` block of /data/msg.collab.codes/node/appconfig.json (collab-messages/src/layer_1_external/pg/pool.ts)
# and, from pg_01 on, refuses to run without a Postgres. Nothing wrote that block on a VM.
#
# What it does (idempotent; a re-run changes nothing that is already right):
#   1. role `cm` (LOGIN, no superuser/CREATEDB/CREATEROLE) and database `cm` OWNED by it: the cm creates its own schema (`msg_core`).
#   2. the role's password is made ON THIS MACHINE the first time and kept in ${PASS_FILE} (root only, outside the repository). It is
#      never printed and never passed as a command argument. A role that already exists WITHOUT that file is left untouched (its
#      password is unknown here: changing it could lock out whoever uses it), and then no block is written.
#   3. a login by TCP on 127.0.0.1 with that password (`select 1`), the way the cm connects.
#   4. the `db` block in the appconfig, only when it does not exist (msg-cm-db.mjs).
#
#   sudo bash scripts/14-postgres-cm.sh
# Step 11 runs it before the release of the cm is installed. Names: CM_DB_USER, CM_DB_DATABASE (default `cm`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -F log_info >/dev/null 2>&1; then
  log_section() { echo ""; echo "=== $* ==="; }
  log_info()    { echo "[INFO] $*"; }
  log_ok()      { echo "[OK]   $*"; }
  log_warn()    { echo "[WARN] $*"; }
  log_error()   { echo "[ERR]  $*" >&2; }
fi

CM_USER="${CM_DB_USER:-cm}"
CM_DATABASE="${CM_DB_DATABASE:-cm}"
DATA_ROOT="${COLLAB_DATA_ROOT:-/data}"
ETC_DIR="${COLLAB_ETC_DIR:-${DATA_ROOT}/etc}"
PASS_FILE="${ETC_DIR}/postgres-cm.pass"
APPCONFIG="${COLLAB_MESSAGES_APPCONFIG:-${COLLAB_MESSAGES_DEPLOY_ROOT:-/data/msg.collab.codes}/node/appconfig.json}"
BLOCK_SCRIPT="${SCRIPT_DIR}/msg-cm-db.mjs"
[[ -f "$BLOCK_SCRIPT" ]] || BLOCK_SCRIPT="/usr/local/lib/collab/msg-cm-db.mjs"

log_section "Step 14 — Postgres of collab-messages (role ${CM_USER}, database ${CM_DATABASE})"

if ! command -v psql >/dev/null 2>&1; then
  log_warn "psql not found — skipping the cm database (is PostgreSQL installed?)"
  exit 0
fi

_psql_super() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$@"
}

role_exists=false
if _psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${CM_USER}';" | grep -q 1; then role_exists=true; fi

if [[ -s "$PASS_FILE" ]]; then
  CM_PASSWORD="$(tr -d '\n' < "$PASS_FILE")"
  log_info "password of '${CM_USER}' already in ${PASS_FILE} — reusing it"
elif [[ "$role_exists" == true ]]; then
  log_warn "role '${CM_USER}' exists but ${PASS_FILE} does not — leaving the role and the appconfig untouched"
  exit 0
else
  CM_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  install -d -m 0755 "$ETC_DIR"
  ( umask 077; printf '%s\n' "$CM_PASSWORD" > "$PASS_FILE" )
  chmod 600 "$PASS_FILE"
  log_ok "password of '${CM_USER}' generated and saved to ${PASS_FILE} (mode 600)"
fi

# The SQL goes on stdin: the password never shows up in `ps`.
if [[ "$role_exists" == true ]]; then verb="ALTER"; else verb="CREATE"; fi
printf '%s ROLE "%s" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"'"'%s'"'"';\n' \
  "$verb" "$CM_USER" "$CM_PASSWORD" | _psql_super >/dev/null
log_ok "role '${CM_USER}' ready"

if _psql_super -tAc "SELECT 1 FROM pg_database WHERE datname = '${CM_DATABASE}';" | grep -q 1; then
  log_ok "database '${CM_DATABASE}' already exists"
else
  _psql_super -c "CREATE DATABASE \"${CM_DATABASE}\" OWNER \"${CM_USER}\";" >/dev/null
  log_ok "database '${CM_DATABASE}' created (owner '${CM_USER}')"
fi

# The way the cm connects: TCP on 127.0.0.1 with the password.
if [[ "$(PGPASSWORD="$CM_PASSWORD" psql -X -h 127.0.0.1 -p "${CM_DB_PORT:-5432}" -U "$CM_USER" -d "$CM_DATABASE" -tAc 'select 1' 2>/dev/null)" != "1" ]]; then
  log_error "role '${CM_USER}' cannot log in on 127.0.0.1 to '${CM_DATABASE}' with its password (check pg_hba.conf)"
  exit 1
fi
log_ok "'${CM_USER}' logs in on 127.0.0.1 (select 1)"

if [[ ! -f "$APPCONFIG" ]]; then
  log_warn "${APPCONFIG} not found — no db block written (run this step again after the cm install)"
  exit 0
fi
if [[ ! -f "$BLOCK_SCRIPT" ]]; then
  log_error "msg-cm-db.mjs not found (${BLOCK_SCRIPT})"
  exit 1
fi
node "$BLOCK_SCRIPT" --appconfig "$APPCONFIG" --password-file "$PASS_FILE" --database "$CM_DATABASE" --user "$CM_USER" --port "${CM_DB_PORT:-5432}"
