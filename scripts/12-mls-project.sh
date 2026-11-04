#!/bin/bash
# scripts/12-mls-project.sh
# Make the VM's client project be BORN HERE, so the developer can `git clone` it.
#
# WHY THIS STEP EXISTS
# Until now the bootstrap ended with the platform in /data/mls-base and NO client project:
# no mls-<id> folder, no git repo, no push hook. `--project-id` reached install.sh and was
# used only for the agent env and the report back to collab-sites. A brand-new VM was
# therefore NOT clonable, and the only way to get there was a command run by hand from the
# Mac (mls-base `pnpm vm:init`, which does the same thing over ssh).
#
# NO LOGIC OF ITS OWN: the rule lives in mls-base (scripts/runtime/projectInit.mjs), which
# is where it is versioned, tested and shared with the ssh path. This step only decides
# WHEN to call it and AS WHOM.
#
# Skipped, not failed, when there is no --project-id: a VM may legitimately be provisioned
# before anyone decides which project lives on it.
# Idempotent: projectInit does nothing when the project is already there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 12 — client project on the VM (git-ready)"

MLS_BASE_DIR="${MLS_BASE_DIR:-/data/mls-base}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-/data/.pnpm-store}"
resolve_deploy_user
AGENT_ENV="${AGENT_ENV:-/etc/collab/sites-agent.env}"

# install.sh exports PROJECT_ID; the agent env is the fallback, so a re-run of this step
# alone (without the installer's arguments) still knows which project this VM hosts.
project_id="${PROJECT_ID:-}"
if [[ -z "$project_id" && -f "$AGENT_ENV" ]]; then
  project_id="$(sed -n 's/^COLLAB_SITES_PROJECT_ID=//p' "$AGENT_ENV" | head -n 1)"
fi

if [[ -z "$project_id" ]]; then
  log_info "no --project-id (and none in ${AGENT_ENV}) — nothing to create"
  exit 0
fi
if ! [[ "$project_id" =~ ^[0-9]+$ ]]; then
  log_error "invalid project id: '${project_id}'"
  exit 1
fi

if [[ ! -d "${MLS_BASE_DIR}/.git" ]]; then
  log_error "${MLS_BASE_DIR} is not an mls-base checkout — did step 10 run?"
  exit 1
fi
if ! command_exists node || ! command_exists git; then
  log_error "node and git are required — did steps 06 and 10 run?"
  exit 1
fi

# Default (MLS_PROJECT_TREE unset): the shared tree, as before — the sites still sends /data/mls-base
# until its own change. MLS_PROJECT_TREE=1 installs the project in /data/app<id>/mls-base instead.
if [[ "${MLS_PROJECT_TREE:-0}" != "1" ]]; then
  PROJECT_INIT="${MLS_BASE_DIR}/scripts/runtime/projectInit.mjs"
  if [[ ! -f "$PROJECT_INIT" ]]; then
    log_error "${PROJECT_INIT} not found — did step 10 (mls-base checkout) run?"
    exit 1
  fi
  if ! command_exists node; then
    log_error "node not found — did step 06 run?"
    exit 1
  fi

  # As the owner of /data/mls-base, never as root: the repo the developer pushes to must
  # belong to the deploy user, exactly like the checkout step 10 creates.
  log_info "creating mls-${project_id} in ${MLS_BASE_DIR} from model (as ${DEPLOY_USER})"
  if [[ "$DEPLOY_USER" == "root" ]]; then
    node "$PROJECT_INIT" "$project_id" --root "$MLS_BASE_DIR" --from-model
  else
    sudo -u "$DEPLOY_USER" node "$PROJECT_INIT" "$project_id" --root "$MLS_BASE_DIR" --from-model
  fi

  log_ok "mls-${project_id} is git-ready — clone it with: git clone <vm>:${MLS_BASE_DIR}/mls-${project_id}"
  exit 0
fi

# One tree per project. Step 10 keeps the shared checkout at MLS_BASE_DIR;
# this step clones that commit into /data/app<id>/mls-base and never deletes it.
PROJECT_ROOT="/data/app${project_id}/mls-base"
commit="$(git -C "$MLS_BASE_DIR" rev-parse HEAD)"
log_info "project tree ${PROJECT_ROOT} at ${commit} (as ${DEPLOY_USER})"
ensure_dir "$(dirname "$PROJECT_ROOT")"
chown "${DEPLOY_USER}:" "$(dirname "$PROJECT_ROOT")"
if [[ ! -d "${PROJECT_ROOT}/.git" ]]; then
  if [[ "$DEPLOY_USER" == "root" ]]; then
    git clone "$MLS_BASE_DIR" "$PROJECT_ROOT"
    git -C "$PROJECT_ROOT" checkout --detach "$commit"
  else
    sudo -u "$DEPLOY_USER" git clone "$MLS_BASE_DIR" "$PROJECT_ROOT"
    sudo -u "$DEPLOY_USER" git -C "$PROJECT_ROOT" checkout --detach "$commit"
  fi
else
  log_info "checkout already present — leaving its commit (re-run does not clone again)"
fi
chown -R "${DEPLOY_USER}:" "$PROJECT_ROOT"

if [[ -f "${PROJECT_ROOT}/package.json" ]]; then
  ensure_dir "$PNPM_STORE_DIR"
  chown "${DEPLOY_USER}:" "$PNPM_STORE_DIR"
  log_info "pnpm install in ${PROJECT_ROOT} (store ${PNPM_STORE_DIR})"
  if [[ "$DEPLOY_USER" == "root" ]]; then
    (cd "$PROJECT_ROOT" && pnpm install --store-dir "$PNPM_STORE_DIR")
  else
    sudo -u "$DEPLOY_USER" -H bash -lc "cd $(printf '%q' "$PROJECT_ROOT") && pnpm install --store-dir $(printf '%q' "$PNPM_STORE_DIR")"
  fi
fi

env_file="${PROJECT_ROOT}/.env"
touch "$env_file"
ensure_env_assignment() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$env_file"; then
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >> "$env_file"
}
ensure_env_assignment CBE_PROJECTS_DIR "$PROJECT_ROOT"
ensure_env_assignment CBE_STATIC_DIR "${PROJECT_ROOT}/static"
chown "${DEPLOY_USER}:" "$env_file"

PROJECT_INIT="${PROJECT_ROOT}/scripts/runtime/projectInit.mjs"
if [[ ! -f "$PROJECT_INIT" ]]; then
  log_error "${PROJECT_INIT} not found after the project clone"
  exit 1
fi
log_info "creating mls-${project_id} in ${PROJECT_ROOT} from model (as ${DEPLOY_USER})"
if [[ "$DEPLOY_USER" == "root" ]]; then
  node "$PROJECT_INIT" "$project_id" --root "$PROJECT_ROOT" --from-model
else
  sudo -u "$DEPLOY_USER" node "$PROJECT_INIT" "$project_id" --root "$PROJECT_ROOT" --from-model
fi

# pm2.apps.d of this tree points the app at <project>/current. Start only once
# a release exists; a brand-new tree has no current yet.
tail3="${project_id: -3}"
port=$((2000 + 10#$tail3))
app_name="app${port}"
if [[ "$DEPLOY_USER" == "root" ]]; then
  (cd "$PROJECT_ROOT" && PROJECT_ROOT="$PROJECT_ROOT" PROJECT_ID="$project_id" node --input-type=module -e 'import { ensureProjectApp } from "./scripts/runtime/vmApps.mjs"; console.log(JSON.stringify(ensureProjectApp({ root: process.env.PROJECT_ROOT, projectId: process.env.PROJECT_ID })));')
else
  sudo -u "$DEPLOY_USER" bash -lc "cd $(printf '%q' "$PROJECT_ROOT") && PROJECT_ROOT=$(printf '%q' "$PROJECT_ROOT") PROJECT_ID=$(printf '%q' "$project_id") node --input-type=module -e 'import { ensureProjectApp } from \"./scripts/runtime/vmApps.mjs\"; console.log(JSON.stringify(ensureProjectApp({ root: process.env.PROJECT_ROOT, projectId: process.env.PROJECT_ID })));'"
fi
app_config="${PROJECT_ROOT}/pm2.apps.d/${app_name}.config.js"
if [[ -L "${PROJECT_ROOT}/current" || -d "${PROJECT_ROOT}/current" ]]; then
  if command_exists pm2; then
    pm2 startOrReload "$app_config" --update-env
    log_ok "pm2 ${app_name} → ${PROJECT_ROOT}/current"
  else
    log_warn "pm2 not found — ${app_config} is written; start ${app_name} after step 08"
  fi
else
  log_info "no release at ${PROJECT_ROOT}/current yet — ${app_name} is configured and starts after the first release"
fi

log_ok "mls-${project_id} is git-ready — clone it with: git clone <vm>:${PROJECT_ROOT}/mls-${project_id}"
