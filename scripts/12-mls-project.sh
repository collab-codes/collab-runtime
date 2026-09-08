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
