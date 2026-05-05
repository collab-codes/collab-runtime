#!/bin/bash
# core/utils.sh
# Shared utility functions for collab-runtime install system.
# Provides: command_exists, service_active, require_root, apt_retry
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"

# ---------------------------------------------------------------------------
# command_exists <cmd>
# Returns 0 if the command is on PATH, 1 otherwise.
# ---------------------------------------------------------------------------
command_exists() {
  command -v "$1" &>/dev/null
}

# ---------------------------------------------------------------------------
# service_active <service>
# Returns 0 if the systemd service is currently active (running), 1 otherwise.
# ---------------------------------------------------------------------------
service_active() {
  systemctl is-active --quiet "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# require_root
# Hard-exits with an error message if the effective user is not root.
# ---------------------------------------------------------------------------
require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "[ERR]  This script must be run as root. Use: sudo $0" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# apt_retry <max_attempts> <apt-get arguments...>
# Runs apt-get with retries on transient network/lock failures.
# Example: apt_retry 3 install -y timescaledb-2-postgresql-17
# ---------------------------------------------------------------------------
apt_retry() {
  local max_attempts="$1"
  shift
  local attempt=1
  local wait_secs=10

  while (( attempt <= max_attempts )); do
    if DEBIAN_FRONTEND=noninteractive apt-get "$@"; then
      return 0
    fi
    if (( attempt < max_attempts )); then
      echo "[WARN]  apt-get $* failed (attempt ${attempt}/${max_attempts}). Retrying in ${wait_secs}s…" >&2
      sleep "$wait_secs"
      apt-get update -y 2>/dev/null || true
      (( wait_secs *= 2 )) || true
    fi
    (( attempt++ )) || true
  done

  echo "[ERR]   apt-get $* failed after ${max_attempts} attempts." >&2
  return 1
}

# ---------------------------------------------------------------------------
# ensure_dir <path> [permissions]
# Creates a directory with optional permissions if it does not exist.
# ---------------------------------------------------------------------------
ensure_dir() {
  local dir="$1"
  local perms="${2:-755}"
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir"
    chmod "$perms" "$dir"
  fi
}

# ---------------------------------------------------------------------------
# print_versions_table
# Pretty-prints installed component versions to stdout.
# ---------------------------------------------------------------------------
print_versions_table() {
  echo ""
  echo "  Installed versions:"
  printf "  %-20s %s\n" "Component" "Version"
  printf "  %-20s %s\n" "---------" "-------"

  command_exists nginx      && printf "  %-20s %s\n" "nginx"      "$(nginx -v 2>&1 | sed 's/nginx version: nginx\///')"
  command_exists psql       && printf "  %-20s %s\n" "postgresql" "$(psql --version | awk '{print $3}')"
  command_exists redis-cli  && printf "  %-20s %s\n" "redis"      "$(redis-server --version | awk '{print $3}' | cut -d= -f2)"
  command_exists node       && printf "  %-20s %s\n" "node"       "$(node --version)"
  command_exists npm        && printf "  %-20s %s\n" "npm"        "$(npm --version)"
  command_exists pm2        && printf "  %-20s %s\n" "pm2"        "$(pm2 --version 2>/dev/null)"
  command_exists 7z         && printf "  %-20s %s\n" "7zip"       "$(7z i 2>&1 | awk '/7-Zip/{print $2; exit}')"
  echo ""
}
