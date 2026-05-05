#!/bin/bash
# core/check-os.sh
# Validates that the current OS is Ubuntu 24.04 LTS.
# Hard-exits (exit 1) if the check fails.
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/check-os.sh"
#   or:  bash core/check-os.sh   (standalone)

set -euo pipefail

_REQUIRED_ID="ubuntu"
_REQUIRED_VERSION="24.04"
_REQUIRED_CODENAME="noble"
_REQUIRED_DESCRIPTION="Ubuntu 24.04"

check_os() {
  # /etc/os-release is the canonical source on modern Linux
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
    echo "[ERR]  Unsupported OS: '${os_id}'. collab-runtime requires Ubuntu 24.04 LTS." >&2
    echo "[ERR]  Detected: ${PRETTY_NAME:-unknown}" >&2
    exit 1
  fi

  if [[ "$os_version" != "$_REQUIRED_VERSION" ]]; then
    echo "[ERR]  Unsupported Ubuntu version: ${os_version}." >&2
    echo "[ERR]  collab-runtime requires Ubuntu ${_REQUIRED_VERSION} LTS (${_REQUIRED_CODENAME})." >&2
    echo "[ERR]  Detected: ${PRETTY_NAME:-unknown}" >&2
    exit 1
  fi

  if [[ "${os_codename,,}" != "$_REQUIRED_CODENAME" ]]; then
    echo "[ERR]  Unexpected codename: '${os_codename}'." >&2
    echo "[ERR]  Expected '${_REQUIRED_CODENAME}' for Ubuntu ${_REQUIRED_VERSION} LTS." >&2
    exit 1
  fi

  # All checks passed
  echo "[OK]   OS check passed: ${PRETTY_NAME} (${os_codename})"
}

# Run when sourced from install.sh — check_os is called by install.sh explicitly.
# If executed directly, run the check immediately.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  check_os
fi
