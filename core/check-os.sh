#!/bin/bash
# core/check-os.sh
# Validates that the current OS is Ubuntu >= 24.04.
# Hard-exits (exit 1) if the check fails.
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/check-os.sh"
#   or:  bash core/check-os.sh   (standalone)

set -euo pipefail

_REQUIRED_ID="ubuntu"
_MIN_MAJOR=24
_MIN_MINOR=4   # 24.04 → major=24 minor=4

check_os() {
  if [[ ! -f /etc/os-release ]]; then
    echo "[ERR]  /etc/os-release not found. Cannot determine OS." >&2
    exit 1
  fi

  # shellcheck source=/dev/null
  . /etc/os-release

  local os_id="${ID:-unknown}"
  local os_version="${VERSION_ID:-unknown}"
  local os_codename="${VERSION_CODENAME:-unknown}"

  if [[ "${os_id,,}" != "$_REQUIRED_ID" ]]; then
    echo "[ERR]  Unsupported OS: '${os_id}'. collab-runtime requires Ubuntu >= 24.04." >&2
    echo "[ERR]  Detected: ${PRETTY_NAME:-unknown}" >&2
    exit 1
  fi

  # Split VERSION_ID into major.minor (e.g. "24.04" → major=24 minor=4)
  local major minor
  major="$(echo "$os_version" | cut -d. -f1)"
  minor="$(echo "$os_version" | cut -d. -f2 | sed 's/^0*//')"
  minor="${minor:-0}"

  local version_ok=false
  if (( major > _MIN_MAJOR )); then
    version_ok=true
  elif (( major == _MIN_MAJOR && minor >= _MIN_MINOR )); then
    version_ok=true
  fi

  if [[ "$version_ok" != true ]]; then
    echo "[ERR]  Unsupported Ubuntu version: ${os_version}." >&2
    echo "[ERR]  collab-runtime requires Ubuntu >= ${_MIN_MAJOR}.0${_MIN_MINOR}." >&2
    echo "[ERR]  Detected: ${PRETTY_NAME:-unknown}" >&2
    exit 1
  fi

  echo "[OK]   OS check passed: ${PRETTY_NAME} (${os_codename})"
}

# Run when sourced from install.sh — check_os is called by install.sh explicitly.
# If executed directly, run the check immediately.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  check_os
fi
