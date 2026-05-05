#!/bin/bash
# install.sh — collab-runtime main installer
#
# Bootstrap and install the full collab server stack on Ubuntu 24.04 LTS.
#
# Usage:
#   sudo ./install.sh [--profile=small|medium|enterprise]
#
# Requirements:
#   - Ubuntu 24.04 LTS (exits immediately on any other OS)
#   - Must be run as root

# ── Strict mode (set before sourcing anything) ────────────────────────────────
set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────────────
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Log paths (referenced by logger.sh) ───────────────────────────────────────
export LOG_DIR="/var/log/collab"
export SUMMARY_LOG="${LOG_DIR}/install-summary.log"
export DETAIL_LOG="${LOG_DIR}/install-detail.log"

# ── Ensure log directory exists early so tee can write to DETAIL_LOG ─────────
mkdir -p "$LOG_DIR"
chmod 755 "$LOG_DIR"
touch "$DETAIL_LOG" "$SUMMARY_LOG"

# ── Redirect ALL stdout+stderr to detail log AND terminal ─────────────────────
# From this point on, every line of output goes to DETAIL_LOG automatically.
exec > >(tee -a "$DETAIL_LOG") 2>&1

# ── Source core helpers ────────────────────────────────────────────────────────
# shellcheck source=core/logger.sh
source "${INSTALL_DIR}/core/logger.sh"
# shellcheck source=core/utils.sh
source "${INSTALL_DIR}/core/utils.sh"
# shellcheck source=core/check-os.sh
source "${INSTALL_DIR}/core/check-os.sh"

# ── Step 1: Must be run as root ────────────────────────────────────────────────
require_root

# ── Step 2: Parse arguments ────────────────────────────────────────────────────
PROFILE="medium"  # default

for arg in "$@"; do
  case "$arg" in
    --profile=*)
      PROFILE="${arg#--profile=}"
      ;;
    --help|-h)
      echo ""
      echo "Usage: sudo ./install.sh [--profile=small|medium|enterprise]"
      echo ""
      echo "Profiles:"
      echo "  small      1-2 vCPU / 1-2 GB RAM"
      echo "  medium     2-4 vCPU / 4-8 GB RAM  (default)"
      echo "  enterprise 8+ vCPU / 32+ GB RAM"
      echo ""
      exit 0
      ;;
    *)
      echo "[ERR]  Unknown argument: ${arg}" >&2
      echo "Usage: sudo ./install.sh [--profile=small|medium|enterprise]" >&2
      exit 1
      ;;
  esac
done

# ── Step 3: Load profile ───────────────────────────────────────────────────────
PROFILE_CONF="${INSTALL_DIR}/profiles/${PROFILE}/profile.conf"
if [[ ! -f "$PROFILE_CONF" ]]; then
  echo "[ERR]  Profile '${PROFILE}' not found. Expected: ${PROFILE_CONF}" >&2
  echo "[ERR]  Valid profiles: small, medium, enterprise" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$PROFILE_CONF"

# Export version variables so child scripts can inherit them
export PG_VERSION="${PG_VERSION:-17}"
export NODE_VERSION="${NODE_VERSION:-24}"

# ── Step 4: Validate OS ────────────────────────────────────────────────────────
check_os   # hard-exits if not Ubuntu 24.04 LTS

# ── Step 5: Initialise logs ────────────────────────────────────────────────────
init_logs

# ── Step 6: Print banner ───────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║          collab-runtime — server installer               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Profile   : ${PROFILE} — ${PROFILE_DESCRIPTION:-}"
echo "  PostgreSQL: ${PG_VERSION}"
echo "  Node.js   : ${NODE_VERSION}.x"
echo "  Log (summary) : ${SUMMARY_LOG}"
echo "  Log (detail)  : ${DETAIL_LOG}"
echo "  Started at: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
log_summary "Profile: ${PROFILE} | PG: ${PG_VERSION} | Node: ${NODE_VERSION}"

# ── Step 6.5: Remove stale apt repos from any previous failed run ─────────────
# Third-party repos added in a previous run may reference a wrong Ubuntu
# codename (e.g. "questing") that is unsupported. If left in place, every
# subsequent apt-get update fails, cascading to all other steps.
# Each install script re-adds its own repo after this cleanup.
log_section "Pre-flight: cleaning stale apt repos"

_STALE_REPOS=(
  /etc/apt/sources.list.d/timescale_timescaledb.list
  /etc/apt/sources.list.d/redis.list
  /etc/apt/sources.list.d/nodesource.list
)
for _repo in "${_STALE_REPOS[@]}"; do
  if [[ -f "$_repo" ]]; then
    rm -f "$_repo"
    log_info "Removed stale repo: ${_repo}"
  fi
done
# Remove orphaned keyring if redis.list was removed
rm -f /usr/share/keyrings/redis-archive-keyring.gpg 2>/dev/null || true
log_ok "Stale repo cleanup done"

# ── Step 7: Run install scripts ────────────────────────────────────────────────
# Each script is run in a subshell. On failure, we log the error and continue
# so that all steps are attempted and the summary accurately reflects what
# passed and what failed.

run_step() {
  local step_num="$1"
  local step_name="$2"
  local script="$3"

  log_section "Running ${step_name}"

  if bash "${INSTALL_DIR}/scripts/${script}"; then
    record_step_result "$step_name" "PASS"
    log_ok "${step_name} completed successfully"
  else
    local exit_code=$?
    record_step_result "$step_name" "FAIL" "exit code ${exit_code}"
    log_error "${step_name} FAILED with exit code ${exit_code}"
    log_error "Check ${DETAIL_LOG} for details"
    # Do not exit — continue with remaining steps
  fi
}

run_step 01 "Ubuntu System Update"    "01-ubuntu-update.sh"
run_step 02 "Install NGINX"           "02-install-nginx.sh"
run_step 03 "Install PostgreSQL"      "03-install-postgres.sh"
run_step 04 "Install TimescaleDB"     "04-install-timescaledb.sh"
run_step 05 "Install Redis"           "05-install-redis.sh"
run_step 06 "Install Node.js"         "06-install-node.sh"
run_step 07 "Install 7-Zip"           "07-install-7zip.sh"
run_step 08 "Install PM2"             "08-install-pm2.sh"

# ── Step 8: Install collab CLI ────────────────────────────────────────────────
log_section "Installing collab CLI"

CLI_SRC="${INSTALL_DIR}/collab"
CLI_DEST="/usr/local/bin/collab"

if [[ -f "$CLI_SRC" ]]; then
  cp "$CLI_SRC" "$CLI_DEST"
  chmod +x "$CLI_DEST"
  record_step_result "collab CLI" "PASS" "installed to ${CLI_DEST}"
  log_ok "collab CLI installed to ${CLI_DEST}"
else
  record_step_result "collab CLI" "FAIL" "source file not found: ${CLI_SRC}"
  log_error "collab CLI source not found at ${CLI_SRC}"
fi

# ── Step 9: Finalize and print summary ─────────────────────────────────────────
finalize_logs

# ── Step 10: Print next steps ──────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                    Next steps                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  1. SSL is NOT installed."
echo "     → Run install-ssl.sh (or use Certbot) when your domain is ready."
echo ""
echo "  2. Client application is NOT deployed."
echo "     → Deploy your app and register it with PM2:"
echo "         pm2 start app.js --name my-app"
echo "         pm2 save"
echo ""
echo "  3. Check your server health at any time:"
echo "         collab status"
echo "         collab doctor"
echo ""
echo "  4. View logs:"
echo "         collab logs"
echo "         collab logs --detail"
echo ""
echo "  Logs written to:"
echo "    Summary : ${SUMMARY_LOG}"
echo "    Detail  : ${DETAIL_LOG}"
echo ""
