#!/bin/bash
# install.sh — collab-runtime main installer
#
# Bootstrap and install the full collab server stack on Ubuntu 24.04 LTS.
#
# Usage:
#   sudo ./install.sh [--profile=small|medium|enterprise] [--server-id=srv_...] [--project-id=102051] [--sites-url=https://sites.collab.codes] [--region=us-east-1] [--agent-token=...] [--agent-env=/etc/collab/sites-agent.env] [--messages-host]
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
SERVER_ID=""
PROJECT_ID=""
SITES_URL=""
REGION=""
AGENT_TOKEN=""
AGENT_ENV="/etc/collab/sites-agent.env"
MESSAGES_HOST=false

for arg in "$@"; do
  case "$arg" in
    --profile=*)
      PROFILE="${arg#--profile=}"
      ;;
    --server-id=*)
      SERVER_ID="${arg#--server-id=}"
      ;;
    --project-id=*)
      PROJECT_ID="${arg#--project-id=}"
      ;;
    --sites-url=*)
      SITES_URL="${arg#--sites-url=}"
      ;;
    --region=*)
      REGION="${arg#--region=}"
      ;;
    --agent-token=*)
      AGENT_TOKEN="${arg#--agent-token=}"
      ;;
    --agent-env=*)
      AGENT_ENV="${arg#--agent-env=}"
      ;;
    --messages-host)
      MESSAGES_HOST=true
      ;;
    --help|-h)
      echo ""
      echo "Usage: sudo ./install.sh [--profile=small|medium|enterprise] [--server-id=srv_...] [--project-id=102051] [--sites-url=https://sites.collab.codes] [--region=us-east-1] [--agent-token=...] [--agent-env=/etc/collab/sites-agent.env] [--messages-host]"
      echo ""
      echo "Profiles:"
      echo "  small      1-2 vCPU / 1-2 GB RAM"
      echo "  medium     2-4 vCPU / 4-8 GB RAM  (default)"
      echo "  enterprise 8+ vCPU / 32+ GB RAM"
      echo ""
      echo "collab-sites agent:"
      echo "  --server-id   Server id registered in collab-sites"
      echo "  --project-id  Project id hosted by this runtime"
      echo "  --sites-url   collab-sites base URL"
      echo "  --region      AWS region where this runtime is running"
      echo "  --agent-token Runtime heartbeat token issued by collab-sites"
      echo "  --agent-env   Root-only env file with heartbeat token"
      echo "  --messages-host  Install collab-messages on this VM (org host only; default: skip)"
      echo ""
      exit 0
      ;;
    *)
      echo "[ERR]  Unknown argument: ${arg}" >&2
      echo "Usage: sudo ./install.sh [--profile=small|medium|enterprise] [--server-id=srv_...] [--project-id=102051] [--sites-url=https://sites.collab.codes] [--region=us-east-1] [--agent-token=...] [--agent-env=/etc/collab/sites-agent.env] [--messages-host]" >&2
      exit 1
      ;;
  esac
done

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

collab_sites_can_report() {
  [[ -n "$SERVER_ID" && -n "$PROJECT_ID" && -n "$SITES_URL" && -n "$AGENT_TOKEN" ]]
}

collab_sites_redact() {
  local text="$1"
  if [[ -n "${AGENT_TOKEN:-}" ]]; then
    text="${text//$AGENT_TOKEN/}"
  fi
  printf '%s' "$text"
}

collab_sites_append_event_log() {
  local code="$1"
  local level="$2"
  local status="$3"
  local http_code="$4"
  local ok="$5"
  local events_log="${LOG_DIR}/sites-events.jsonl"
  local ts http_n
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  http_n=0
  if [[ "${http_code:-0}" =~ ^[0-9]+$ ]]; then
    http_n=$((10#$http_code)) || http_n=0
  fi
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s\n' "{\"ts\":\"$(json_escape "$ts")\",\"code\":\"$(json_escape "$code")\",\"level\":\"$(json_escape "$level")\",\"status\":\"$(json_escape "$status")\",\"http\":${http_n},\"ok\":${ok}}" >> "$events_log" || true
}

collab_sites_event() {
  local level="$1"
  local code="$2"
  local message="$3"
  local status="${4:-}"
  local details="${5:-{}}"
  local http_code="000"
  local ok="false"
  local body=""
  local tmp payload

  if ! collab_sites_can_report || ! command -v curl >/dev/null 2>&1; then
    if collab_sites_can_report; then
      log_warn "Cannot report collab-sites event '${code}': curl is not installed yet"
    fi
    collab_sites_append_event_log "$code" "$level" "$status" "$http_code" "$ok"
    return 0
  fi

  payload="{\"projectId\":\"$(json_escape "$PROJECT_ID")\",\"token\":\"$(json_escape "$AGENT_TOKEN")\",\"level\":\"$(json_escape "$level")\",\"code\":\"$(json_escape "$code")\",\"message\":\"$(json_escape "$message")\",\"status\":\"$(json_escape "$status")\",\"details\":${details}}"
  tmp="$(mktemp)"
  http_code="$(curl -sS \
    -o "$tmp" \
    -w '%{http_code}' \
    --max-time 10 \
    -H "Content-Type: application/json" \
    -H "X-Collab-Origin: collab-runtime-install" \
    -X POST \
    --data-binary "$payload" \
    "${SITES_URL%/}/api/v1/servers/${SERVER_ID}/events" || true)"
  [[ -n "$http_code" ]] || http_code="000"

  body="$(head -c 200 "$tmp" 2>/dev/null || true)"
  body="${body//$'\n'/ }"
  rm -f "$tmp"

  if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    ok="true"
  else
    log_warn "Failed to report collab-sites event '${code}': http=${http_code} body=$(collab_sites_redact "$body")"
  fi
  collab_sites_append_event_log "$code" "$level" "$status" "$http_code" "$ok"
  return 0
}

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

# ── Step 6.4: Bound apt BEFORE the first apt-get ──────────────────────────────
# Without this, a dead EC2 ports mirror hangs forever (102052, 32 min, no ESTAB).
log_section "Pre-flight: apt network bounds"
configure_apt_network

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

if collab_sites_can_report && ! command -v curl >/dev/null 2>&1; then
  log_section "Pre-flight: installing curl for collab-sites progress events"
  if apt_cmd install -y curl; then
    log_ok "curl installed for collab-sites progress events"
  else
    log_warn "Could not install curl; collab-sites progress events may be unavailable"
  fi
fi

collab_sites_event "info" "runtime.bootstrap_started" "collab-runtime bootstrap started" "" "{\"profile\":\"$(json_escape "$PROFILE")\",\"runtimeDir\":\"$(json_escape "$INSTALL_DIR")\"}"

# ── Step 7: Run install scripts ────────────────────────────────────────────────
# Each script is run in a subshell. On failure, we log the error and continue
# so that all steps are attempted and the summary accurately reflects what
# passed and what failed.

run_step() {
  local step_num="$1"
  local step_name="$2"
  local script="$3"

  log_section "Running ${step_name}"
  collab_sites_event "info" "runtime.step_started" "Starting ${step_name}" "" "{\"step\":\"$(json_escape "$step_name")\",\"script\":\"$(json_escape "$script")\",\"stepNumber\":\"$(json_escape "$step_num")\"}"

  if bash "${INSTALL_DIR}/scripts/${script}"; then
    record_step_result "$step_name" "PASS"
    log_ok "${step_name} completed successfully"
    collab_sites_event "info" "runtime.step_completed" "${step_name} completed successfully" "" "{\"step\":\"$(json_escape "$step_name")\",\"script\":\"$(json_escape "$script")\",\"stepNumber\":\"$(json_escape "$step_num")\"}"
  else
    local exit_code=$?
    record_step_result "$step_name" "FAIL" "exit code ${exit_code}"
    log_error "${step_name} FAILED with exit code ${exit_code}"
    log_error "Check ${DETAIL_LOG} for details"
    collab_sites_event "error" "runtime.step_failed" "${step_name} failed" "failed" "{\"step\":\"$(json_escape "$step_name")\",\"script\":\"$(json_escape "$script")\",\"stepNumber\":\"$(json_escape "$step_num")\",\"exitCode\":${exit_code}}"
    # Do not exit — continue with remaining steps
  fi
}

run_step 00 "Setup Data Disk"         "00-setup-data-disk.sh"
run_step 01 "Ubuntu System Update"    "01-ubuntu-update.sh"
run_step 02 "Install NGINX"           "02-install-nginx.sh"
run_step 03 "Install PostgreSQL"      "03-install-postgres.sh"
run_step 04 "Install TimescaleDB"     "04-install-timescaledb.sh"
run_step 05 "Install Redis"           "05-install-redis.sh"
run_step 06 "Install Node.js"         "06-install-node.sh"
run_step 07 "Install 7-Zip"           "07-install-7zip.sh"
run_step 08 "Install PM2"             "08-install-pm2.sh"
run_step 09 "Install Certbot"         "09-install-certbot.sh"
run_step 10 "mls-base Runtime"        "10-mls-runtime.sh"
if [[ "$MESSAGES_HOST" == true ]]; then
  run_step 11 "collab-messages"         "11-install-collab-messages.sh"
else
  log_section "collab-messages"
  log_info "skipped: not the messages host"
  record_step_result "collab-messages" "SKIP" "skipped: not the messages host"
fi
# PROJECT_ID is exported so the step subshell sees it (run_step passes no arguments).
export PROJECT_ID AGENT_ENV
run_step 12 "mls client project"      "12-mls-project.sh"

# ── Step 8: Install collab CLI ────────────────────────────────────────────────
log_section "Installing collab CLI"

CLI_SRC="${INSTALL_DIR}/collab"
CLI_DEST="/usr/local/bin/collab"

if [[ -f "$CLI_SRC" ]]; then
  cp "$CLI_SRC" "$CLI_DEST"
  chmod +x "$CLI_DEST"
  mkdir -p /usr/local/lib/collab
  cp "${INSTALL_DIR}/scripts/11-install-collab-messages.sh" /usr/local/lib/collab/install-collab-messages.sh
  chmod +x /usr/local/lib/collab/install-collab-messages.sh
  cp "${INSTALL_DIR}/scripts/msg-configure.mjs" /usr/local/lib/collab/msg-configure.mjs
  chmod +x /usr/local/lib/collab/msg-configure.mjs
  cp "${INSTALL_DIR}/scripts/msg-vapid.mjs" /usr/local/lib/collab/msg-vapid.mjs
  chmod +x /usr/local/lib/collab/msg-vapid.mjs
  record_step_result "collab CLI" "PASS" "installed to ${CLI_DEST}"
  log_ok "collab CLI installed to ${CLI_DEST}"
  collab_sites_event "info" "runtime.cli_installed" "collab CLI installed" "" "{\"path\":\"$(json_escape "$CLI_DEST")\"}"
else
  record_step_result "collab CLI" "FAIL" "source file not found: ${CLI_SRC}"
  log_error "collab CLI source not found at ${CLI_SRC}"
  collab_sites_event "error" "runtime.cli_failed" "collab CLI source not found" "failed" "{\"path\":\"$(json_escape "$CLI_SRC")\"}"
fi

# ── Step 8.5: Install collab-sites heartbeat agent ────────────────────────────
# Node source is copied as-is. No cargo, no prebuilt binary. If this step fails
# the installer exits 1 after the summary — otherwise the VM stays
# bootstrap_pending forever (no heartbeat).
log_section "Installing collab-sites agent"

AGENT_SRC="${INSTALL_DIR}/agent/collab-sites-agent.mjs"
AGENT_LIB_DIR="/usr/local/lib/collab-sites-agent"
AGENT_DEST="${AGENT_LIB_DIR}/collab-sites-agent.mjs"
AGENT_SERVICE="/etc/systemd/system/collab-sites-agent.service"
AGENT_VERSION="$(sed -n 's/^export const AGENT_VERSION = "\(.*\)";/\1/p' "$AGENT_SRC" 2>/dev/null | head -1)"
AGENT_VERSION="${AGENT_VERSION:-0.0.0}"
AGENT_INSTALL_FAILED=false

fail_agent() {
  local reason="$1"
  AGENT_INSTALL_FAILED=true
  record_step_result "collab-sites agent" "FAIL" "$reason"
  log_error "$reason"
  collab_sites_event "error" "runtime.agent_not_installed" "$reason" "failed" "{\"expectedVersion\":\"$(json_escape "$AGENT_VERSION")\",\"reason\":\"$(json_escape "$reason")\"}"
}

if [[ -n "$SERVER_ID" && -n "$PROJECT_ID" && -n "$SITES_URL" && -n "$AGENT_TOKEN" ]]; then
  mkdir -p "$(dirname "$AGENT_ENV")"
  cat > "$AGENT_ENV" <<EOF
COLLAB_SITES_URL=${SITES_URL%/}
COLLAB_SITES_SERVER_ID=${SERVER_ID}
COLLAB_SITES_PROJECT_ID=${PROJECT_ID}
COLLAB_SITES_AGENT_TOKEN=${AGENT_TOKEN}
COLLAB_SITES_AGENT_BIND=127.0.0.1:5151
COLLAB_SITES_ALLOWED_ORIGIN=sites.collab.codes
COLLAB_SITES_HEARTBEAT_INTERVAL_SECONDS=30
COLLAB_SITES_DATA_ROOT=/data
COLLAB_SITES_RUNTIME_DIR=${INSTALL_DIR}
COLLAB_SITES_REGION=${REGION}
COLLAB_SITES_INSTANCE_ID=
COLLAB_SITES_INSTANCE_ID_FROM_IMDS=true
COLLAB_SITES_AGENT_VERSION=${AGENT_VERSION}
EOF
  chmod 600 "$AGENT_ENV"
  record_step_result "collab-sites agent env" "PASS" "written to ${AGENT_ENV}"
  collab_sites_event "info" "runtime.agent_env_written" "collab-sites agent env written" "" "{\"path\":\"$(json_escape "$AGENT_ENV")\"}"
elif [[ -f "$AGENT_ENV" ]]; then
  record_step_result "collab-sites agent env" "PASS" "using existing ${AGENT_ENV}"
  collab_sites_event "info" "runtime.agent_env_existing" "Using existing collab-sites agent env" "" "{\"path\":\"$(json_escape "$AGENT_ENV")\"}"
else
  record_step_result "collab-sites agent env" "SKIP" "missing --server-id/--project-id/--sites-url/--agent-token"
fi

if [[ ! -f "$AGENT_ENV" ]]; then
  log_info "Skipping collab-sites agent install; env file not written"
elif ! command -v node >/dev/null 2>&1; then
  fail_agent "node is not on PATH; step 06 (Install Node.js) failed"
elif [[ ! -f "$AGENT_SRC" ]]; then
  fail_agent "agent source missing: ${AGENT_SRC}"
else
  mkdir -p "$AGENT_LIB_DIR"
  if ! cp "$AGENT_SRC" "$AGENT_DEST"; then
    fail_agent "could not copy agent to ${AGENT_DEST}"
  else
    chmod 644 "$AGENT_DEST"
    # Drop the old Rust binary so a previous install cannot keep answering.
    rm -f /usr/local/bin/collab-sites-agent
    if grep -q '^COLLAB_SITES_AGENT_VERSION=' "$AGENT_ENV"; then
      sed -i "s|^COLLAB_SITES_AGENT_VERSION=.*|COLLAB_SITES_AGENT_VERSION=${AGENT_VERSION}|" "$AGENT_ENV"
    else
      echo "COLLAB_SITES_AGENT_VERSION=${AGENT_VERSION}" >> "$AGENT_ENV"
    fi
    chmod 600 "$AGENT_ENV"
    cat > "$AGENT_SERVICE" <<EOF
[Unit]
Description=collab-sites runtime heartbeat agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${AGENT_ENV}
ExecStart=/usr/bin/env node ${AGENT_DEST} --env ${AGENT_ENV}
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    # restart, not `enable --now`: on an already active unit `--now` is a no-op and
    # would keep the previous binary (and the previous env) running.
    if systemctl enable collab-sites-agent && systemctl restart collab-sites-agent; then
      record_step_result "collab-sites agent" "PASS" "installed ${AGENT_VERSION} at ${AGENT_DEST}"
      log_ok "collab-sites agent service enabled and restarted"
      collab_sites_event "info" "runtime.agent_started" "collab-sites agent service enabled" "" "{\"service\":\"collab-sites-agent\",\"agentVersion\":\"$(json_escape "$AGENT_VERSION")\"}"
    else
      fail_agent "systemd could not start collab-sites-agent; check: systemctl status collab-sites-agent"
    fi
  fi
fi

# ── Step 9: Finalize and print summary ─────────────────────────────────────────
finalize_logs

if grep -q "FAIL" "$SUMMARY_LOG"; then
  collab_sites_event "error" "runtime.failed" "collab-runtime bootstrap finished with failures" "failed" "{\"summaryLog\":\"$(json_escape "$SUMMARY_LOG")\",\"detailLog\":\"$(json_escape "$DETAIL_LOG")\"}"
else
  collab_sites_event "info" "runtime.ready" "collab-runtime bootstrap finished" "ready" "{\"summaryLog\":\"$(json_escape "$SUMMARY_LOG")\",\"detailLog\":\"$(json_escape "$DETAIL_LOG")\"}"
fi

# ── Step 10: Print next steps ──────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                    Next steps                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  1. Certbot is installed (SSL ready)."
echo "     → Issue a certificate when your domain points to this server:"
echo "         sudo certbot --nginx -d yourdomain.com"
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

if [[ "${AGENT_INSTALL_FAILED}" == true ]]; then
  log_error "collab-sites agent was not installed; bootstrap exiting 1 so the VM is not reported as ready"
  exit 1
fi
