#!/bin/bash
# core/logger.sh
# Logging utilities for collab-runtime install system.
# Provides: log_info, log_ok, log_error, log_warn, log_section, log_summary,
#           init_logs, finalize_logs
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/logger.sh"
#
# Expects these variables to be set before sourcing (or uses defaults):
#   SUMMARY_LOG  — path for key-events-only log
#   DETAIL_LOG   — path for full output log
#   LOG_DIR      — directory for both logs

LOG_DIR="${LOG_DIR:-/var/log/collab}"
SUMMARY_LOG="${SUMMARY_LOG:-${LOG_DIR}/install-summary.log}"
DETAIL_LOG="${DETAIL_LOG:-${LOG_DIR}/install-detail.log}"

# Colour codes (disabled when not a terminal)
if [[ -t 1 ]]; then
  _C_RESET='\033[0m'
  _C_INFO='\033[0;36m'   # cyan
  _C_OK='\033[0;32m'     # green
  _C_WARN='\033[0;33m'   # yellow
  _C_ERROR='\033[0;31m'  # red
  _C_SECTION='\033[1;35m' # bold magenta
else
  _C_RESET='' _C_INFO='' _C_OK='' _C_WARN='' _C_ERROR='' _C_SECTION=''
fi

# Track pass/fail counts for finalize_logs
_PASS_COUNT=0
_FAIL_COUNT=0
declare -a _STEP_RESULTS=()

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
_ts() { date '+%Y-%m-%d %H:%M:%S'; }

_write_summary() {
  echo "[$(_ts)] $*" >> "$SUMMARY_LOG"
}

# ---------------------------------------------------------------------------
# Public logging functions
# ---------------------------------------------------------------------------

log_info() {
  echo -e "${_C_INFO}[INFO]${_C_RESET}  $*"
  _write_summary "INFO  $*"
}

log_ok() {
  echo -e "${_C_OK}[ OK ]${_C_RESET}  $*"
  _write_summary "OK    $*"
}

log_warn() {
  echo -e "${_C_WARN}[WARN]${_C_RESET}  $*"
  _write_summary "WARN  $*"
}

log_error() {
  echo -e "${_C_ERROR}[ERR ]${_C_RESET}  $*" >&2
  _write_summary "ERROR $*"
}

log_section() {
  local border="────────────────────────────────────────────────────────"
  echo ""
  echo -e "${_C_SECTION}${border}${_C_RESET}"
  echo -e "${_C_SECTION}  $*${_C_RESET}"
  echo -e "${_C_SECTION}${border}${_C_RESET}"
  _write_summary "=== $* ==="
}

# log_summary writes only to the summary log (not stdout)
log_summary() {
  _write_summary "$*"
}

# Record a step result for the final report
# Usage: record_step_result "Step Name" "PASS|FAIL" "optional message"
record_step_result() {
  local name="$1"
  local result="$2"
  local msg="${3:-}"
  _STEP_RESULTS+=("${result}|${name}|${msg}")
  if [[ "$result" == "PASS" ]]; then
    (( _PASS_COUNT++ )) || true
  else
    (( _FAIL_COUNT++ )) || true
  fi
}

# ---------------------------------------------------------------------------
# init_logs — call once at the start of install.sh
# ---------------------------------------------------------------------------
init_logs() {
  mkdir -p "$LOG_DIR"
  chmod 755 "$LOG_DIR"

  local header="collab-runtime install started at $(_ts)"
  local divider="================================================================"

  # Initialise (or append to) both logs
  {
    echo "$divider"
    echo "  $header"
    echo "$divider"
  } >> "$SUMMARY_LOG"

  {
    echo "$divider"
    echo "  $header"
    echo "  SUMMARY : $SUMMARY_LOG"
    echo "  DETAIL  : $DETAIL_LOG"
    echo "$divider"
  } >> "$DETAIL_LOG"

  log_info "Logs initialised → summary: $SUMMARY_LOG"
  log_info "                 → detail:  $DETAIL_LOG"
}

# ---------------------------------------------------------------------------
# finalize_logs — call at the end of install.sh to print the run summary
# ---------------------------------------------------------------------------
finalize_logs() {
  local status_line
  local divider="================================================================"
  local end_time
  end_time="$(_ts)"

  echo ""
  echo -e "${_C_SECTION}${divider}${_C_RESET}"
  echo -e "${_C_SECTION}  Install Summary — ${end_time}${_C_RESET}"
  echo -e "${_C_SECTION}${divider}${_C_RESET}"

  for entry in "${_STEP_RESULTS[@]:-}"; do
    local result name msg
    result="${entry%%|*}"
    name="${entry#*|}"
    msg="${name#*|}"
    name="${name%%|*}"
    if [[ "$result" == "PASS" ]]; then
      echo -e "  ${_C_OK}PASS${_C_RESET}  ${name}${msg:+ — ${msg}}"
      _write_summary "STEP PASS  ${name}${msg:+ — ${msg}}"
    else
      echo -e "  ${_C_ERROR}FAIL${_C_RESET}  ${name}${msg:+ — ${msg}}"
      _write_summary "STEP FAIL  ${name}${msg:+ — ${msg}}"
    fi
  done

  echo ""
  echo -e "  Passed: ${_C_OK}${_PASS_COUNT}${_C_RESET}   Failed: ${_C_ERROR}${_FAIL_COUNT}${_C_RESET}"
  echo -e "${_C_SECTION}${divider}${_C_RESET}"

  {
    echo "$divider"
    echo "  Install finished at ${end_time}  |  passed: ${_PASS_COUNT}  failed: ${_FAIL_COUNT}"
    echo "$divider"
  } >> "$SUMMARY_LOG"

  {
    echo "$divider"
    echo "  Install finished at ${end_time}"
    echo "$divider"
  } >> "$DETAIL_LOG"
}
