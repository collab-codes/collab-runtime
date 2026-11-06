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
MLS_BASE_REPO="${MLS_BASE_REPO:-https://github.com/expansiva/mls-base}"
# One tree per project is the default (rt184): /data/app<id>/mls-base. MLS_PROJECT_TREE=0 keeps the old shared tree.
MLS_PROJECT_TREE="${MLS_PROJECT_TREE:-1}"
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

if [[ "$MLS_PROJECT_TREE" != "1" && ! -d "${MLS_BASE_DIR}/.git" ]]; then
  log_error "${MLS_BASE_DIR} is not an mls-base checkout — did step 10 run?"
  exit 1
fi
if ! command_exists node || ! command_exists git; then
  log_error "node and git are required — did steps 06 and 10 run?"
  exit 1
fi

# MLS_PROJECT_TREE=0 (explicit): the shared tree, as before. Default: the project's own tree below.
if [[ "$MLS_PROJECT_TREE" != "1" ]]; then
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

# One tree per project: /data/app<id>/mls-base. A new VM has no shared checkout (step 10 does not create it), so the
# platform comes straight from the mls-base repo. A VM that still has /data/mls-base clones that commit instead.
PROJECT_ROOT="/data/app${project_id}/mls-base"
ensure_dir "$(dirname "$PROJECT_ROOT")"
chown "${DEPLOY_USER}:" "$(dirname "$PROJECT_ROOT")"
if [[ ! -d "${PROJECT_ROOT}/.git" ]]; then
  if [[ -d "${MLS_BASE_DIR}/.git" ]]; then
    commit="$(git -C "$MLS_BASE_DIR" rev-parse HEAD)"
    log_info "project tree ${PROJECT_ROOT} at ${commit} from ${MLS_BASE_DIR} (as ${DEPLOY_USER})"
    if [[ "$DEPLOY_USER" == "root" ]]; then
      git clone "$MLS_BASE_DIR" "$PROJECT_ROOT"
      git -C "$PROJECT_ROOT" checkout --detach "$commit"
    else
      sudo -u "$DEPLOY_USER" git clone "$MLS_BASE_DIR" "$PROJECT_ROOT"
      sudo -u "$DEPLOY_USER" git -C "$PROJECT_ROOT" checkout --detach "$commit"
    fi
  else
    log_info "project tree ${PROJECT_ROOT} from ${MLS_BASE_REPO} (as ${DEPLOY_USER})"
    if [[ "$DEPLOY_USER" == "root" ]]; then
      git clone "$MLS_BASE_REPO" "$PROJECT_ROOT"
    else
      sudo -u "$DEPLOY_USER" git clone "$MLS_BASE_REPO" "$PROJECT_ROOT"
    fi
  fi
else
  log_info "checkout already present — leaving its commit (re-run does not clone again)"
fi
chown -R "${DEPLOY_USER}:" "$PROJECT_ROOT"

# The runtime .env with the installer's database secrets: the same file step 10 wrote at /data/mls-base on the old
# layout, now in the project's own tree. Left untouched when it is already there.
source "${REPO_ROOT}/scripts/lib/mls-app-db.sh"
ensure_mls_env "$PROJECT_ROOT" "$DEPLOY_USER"

# Everything else a project needs in its own tree is ONE script of mls-base (rt187), also called by the collab-sites
# slot over SSM, so the two never diverge: the dependencies install, the CBE_ keys of the .env, the project from the model, the
# pm2 app config and, only when a release already exists, pm2. It runs as the deploy user (the pm2 daemon is theirs).
PROJECT_TREE_INIT="${PROJECT_ROOT}/scripts/runtime/projectTreeInit.mjs"
if [[ ! -f "$PROJECT_TREE_INIT" ]]; then
  log_error "${PROJECT_TREE_INIT} not found after the project clone — is mls-base on a commit with projectTreeInit.mjs?"
  exit 1
fi
data_root="$(dirname "$(dirname "$PROJECT_ROOT")")"
log_info "creating mls-${project_id} in ${PROJECT_ROOT} (projectTreeInit, as ${DEPLOY_USER})"
if [[ "$DEPLOY_USER" == "root" ]]; then
  tree_result="$(cd "$PROJECT_ROOT" && node "$PROJECT_TREE_INIT" "$project_id" --data "$data_root" --store "$PNPM_STORE_DIR")"
else
  tree_result="$(sudo -u "$DEPLOY_USER" -H bash -lc "cd $(printf '%q' "$PROJECT_ROOT") && node $(printf '%q' "$PROJECT_TREE_INIT") $(printf '%q' "$project_id") --data $(printf '%q' "$data_root") --store $(printf '%q' "$PNPM_STORE_DIR")")"
fi
log_info "projectTreeInit: $(printf '%s' "$tree_result" | tail -n 1)"

log_ok "mls-${project_id} is git-ready — clone it with: git clone <vm>:${PROJECT_ROOT}/mls-${project_id}"
