#!/bin/bash
# scripts/10-mls-runtime.sh
# Prepare this VM to receive and build mls-base publishes:
#   - rsync / git : rsync is used by publishMlsBase.sh to copy sources; git is
#                   used to clone the mls-base scaffold
#   - pnpm        : enabled via corepack (ships with Node.js) to build on the VM
#   - checkout    : /data/mls-base cloned from the mls-base repo and owned by the
#                   deploy user, so the publish rsync does not need sudo
# Idempotent: safe to re-run as part of install.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 10 — mls-base runtime prerequisites"

MLS_BASE_DIR="${MLS_BASE_DIR:-/data/mls-base}"
MLS_BASE_REPO="${MLS_BASE_REPO:-https://github.com/expansiva/mls-base}"
# When invoked through sudo, SUDO_USER is the real login user (the one that will
# rsync from the dev machine). Fall back to root if not run via sudo.
DEPLOY_USER="${SUDO_USER:-root}"

# ── rsync + git ─────────────────────────────────────────────────────────────────
if ! command_exists rsync || ! command_exists git; then
  apt_update_safe
fi
for tool in rsync git; do
  if command_exists "$tool"; then
    log_info "${tool} already installed"
  else
    log_info "Installing ${tool}…"
    apt_retry 3 install -y "$tool"
    log_ok "${tool} installed"
  fi
done

# ── pnpm via corepack ────────────────────────────────────────────────────────────
if command_exists pnpm; then
  log_info "pnpm already available: $(pnpm --version 2>/dev/null)"
elif command_exists corepack; then
  log_info "Enabling pnpm via corepack…"
  corepack enable
  log_ok "pnpm enabled: $(pnpm --version 2>/dev/null || echo enabled)"
else
  log_warn "corepack not found — ensure the Node.js step (06) ran; pnpm not enabled"
fi

# ── mls-base checkout ─────────────────────────────────────────────────────────────
ensure_dir "$MLS_BASE_DIR"
chown "${DEPLOY_USER}:" "$MLS_BASE_DIR"
if [[ -d "${MLS_BASE_DIR}/.git" ]]; then
  log_info "mls-base checkout present — pulling latest…"
  sudo -u "$DEPLOY_USER" git -C "$MLS_BASE_DIR" pull --ff-only || log_warn "git pull failed (continuing)"
else
  log_info "Cloning mls-base into ${MLS_BASE_DIR}…"
  sudo -u "$DEPLOY_USER" git clone "$MLS_BASE_REPO" "$MLS_BASE_DIR" || log_warn "git clone failed (continuing)"
fi
chown -R "${DEPLOY_USER}:" "$MLS_BASE_DIR"
log_ok "${MLS_BASE_DIR} ready (owner: ${DEPLOY_USER})"

# ── runtime .env ─────────────────────────────────────────────────────────────────
# Stable at the mls-base root; addNewVersion.mjs copies it into every release (the
# server and migrate resolve .env from their cwd). Without it the app falls back to
# APP_ENV=development + RUNTIME_MODE=memory and never touches Postgres.
# Credentials match the role created by 03-install-postgres.sh (collab/collab).
ENV_FILE="${MLS_BASE_DIR}/.env"
DB_APP_USER="${DB_APP_USER:-collab}"
DB_APP_PASSWORD="${DB_APP_PASSWORD:-collab}"
DB_APP_DATABASE="${DB_APP_DATABASE:-mdm}"
if [[ -f "$ENV_FILE" ]]; then
  log_info ".env already present at ${ENV_FILE} — leaving it untouched"
else
  log_info "Creating ${ENV_FILE} (production runtime, postgres as '${DB_APP_USER}')…"
  cat > "$ENV_FILE" <<EOF
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
  chown "${DEPLOY_USER}:" "$ENV_FILE"
  log_ok "${ENV_FILE} created"
fi

# ── application database ─────────────────────────────────────────────────────────
# migrate.js creates tables but not the database itself; ensure it exists here.
if command_exists psql; then
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_APP_DATABASE}';" | grep -q 1; then
    log_info "Database '${DB_APP_DATABASE}' already exists"
  else
    log_info "Creating database '${DB_APP_DATABASE}' owned by '${DB_APP_USER}'…"
    sudo -u postgres psql -c "CREATE DATABASE \"${DB_APP_DATABASE}\" OWNER \"${DB_APP_USER}\";"
    log_ok "Database '${DB_APP_DATABASE}' created"
  fi
  # Per-database and superuser-only (step 04 installs the packages; the app cannot
  # enable the extension at runtime — hypertables need it).
  log_info "Ensuring timescaledb extension on '${DB_APP_DATABASE}'…"
  sudo -u postgres psql -d "${DB_APP_DATABASE}" -c 'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;' \
    || log_warn "timescaledb extension not enabled (step 04 ran?) — hypertables fall back to regular tables"
else
  log_warn "psql not found — skipping database creation (run step 03 first)"
fi
