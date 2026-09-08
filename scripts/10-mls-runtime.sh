#!/bin/bash
# scripts/10-mls-runtime.sh
# Prepare this VM to receive and build mls-base publishes:
#   - git         : clones the mls-base scaffold (platform arrives by git pull)
#   - rsync       : still installed; was the tarball copy tool (path deleted)
#   - pnpm        : enabled via corepack (ships with Node.js) to build on the VM
#   - checkout    : /data/mls-base cloned from the mls-base repo, `pnpm install`
#                   run there (no lockfile flag — mls-base `.npmrc` has
#                   frozen-lockfile=false), and owned by the deploy user, so a
#                   push can compile without a prior admin "Build release"
# Idempotent: safe to re-run as part of install.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 10 — mls-base runtime prerequisites"

MLS_BASE_DIR="${MLS_BASE_DIR:-/data/mls-base}"
MLS_BASE_REPO="${MLS_BASE_REPO:-https://github.com/expansiva/mls-base}"
# Same user as pm2 (step 08) and the collab-sites dataOwnerUser: the owner of
# /data, typically ubuntu. Cloud-init runs `sudo install.sh` as root, so
# SUDO_USER is not the deploy user.
resolve_deploy_user

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
  run_with_timeout "$NET_CMD_TIMEOUT_SECS" sudo -u "$DEPLOY_USER" git -C "$MLS_BASE_DIR" pull --ff-only \
    || log_warn "git pull failed (continuing)"
else
  log_info "Cloning mls-base into ${MLS_BASE_DIR}…"
  run_with_timeout "$NET_CMD_TIMEOUT_SECS" sudo -u "$DEPLOY_USER" git clone "$MLS_BASE_REPO" "$MLS_BASE_DIR" \
    || log_warn "git clone failed (continuing)"
fi
chown -R "${DEPLOY_USER}:" "$MLS_BASE_DIR"

# After clone/pull. Without this, the first build dies at `Cannot find
# package 'esbuild'` (measured 03/09, 102043 VM). No lockfile flag: mls-base
# `.npmrc` has frozen-lockfile=false (gb55). As the deploy user so
# node_modules is theirs; -H bash -lc for HOME + corepack PATH.
if [[ -f "${MLS_BASE_DIR}/package.json" ]]; then
  log_info "Installing mls-base dependencies (as ${DEPLOY_USER})…"
  if run_with_timeout 900 sudo -u "$DEPLOY_USER" -H bash -lc "cd \"$MLS_BASE_DIR\" && pnpm install"; then
    log_ok "mls-base dependencies installed"
  else
    log_warn "pnpm install failed in ${MLS_BASE_DIR} — no build will work on this VM until this passes"
  fi
else
  log_warn "no package.json in ${MLS_BASE_DIR} — checkout did not land; no build will work on this VM until this passes"
fi
if [[ -d "${MLS_BASE_DIR}/node_modules" ]]; then
  chown -R "${DEPLOY_USER}:" "${MLS_BASE_DIR}/node_modules"
fi
log_ok "${MLS_BASE_DIR} ready (cloned and installed, owner: ${DEPLOY_USER})"

# ── application role, database and runtime .env ──────────────────────────────────
# One owner for the three: scripts/lib/mls-app-db.sh, also sourced by mls-base's
# vmInitialSetup.sh (the ssh path of the traditional publish). The role itself stays
# 03-install-postgres.sh's job on this path — it already ran by the time we get here.
source "${REPO_ROOT}/scripts/lib/mls-app-db.sh"
ensure_mls_env "$MLS_BASE_DIR" "$DEPLOY_USER"
ensure_app_database
