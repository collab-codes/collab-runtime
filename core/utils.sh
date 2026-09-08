#!/bin/bash
# core/utils.sh
# Shared utility functions for collab-runtime install system.
# Provides: command_exists, service_active, require_root,
#           configure_apt_network, run_with_timeout, apt_cmd, apt_update_safe, apt_retry,
#           file_owner, deploy_home, resolve_deploy_user, run_as_deploy
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"

# ---------------------------------------------------------------------------
# TSDB_SUPPORTED_CODENAMES
# Ubuntu codenames for which TimescaleDB publishes apt packages (packagecloud.io):
#   focal (20.04), jammy (22.04), noble (24.04).
# Single source of truth — consumed by install.sh (early pre-flight warning) and
# scripts/04-install-timescaledb.sh. Verified 2026-05: no package for 26.04 yet.
# Add a codename here once TimescaleDB ships packages for it.
# ---------------------------------------------------------------------------
TSDB_SUPPORTED_CODENAMES="${TSDB_SUPPORTED_CODENAMES:-focal jammy noble}"

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
# Apt / network bounds
#
# Measured 05/09/2026 on VM 102052: `apt-get update -y` sat 32 min with
# /usr/lib/apt/methods/http alive, zero ESTAB sockets, last log line `Ign:`
# on us-east-1.ec2.ports.ubuntu.com. Default apt has no Acquire::http::Timeout
# and no Retries, so a dead mirror (or an IPv6 SYN blackhole) is infinite wait.
# Bootstrap that never ends is worse than bootstrap that fails.
# ---------------------------------------------------------------------------

# Per-connection idle. A live archive in us-east-1 answers in <2s; 30s is slack
# for a congested link. Without this, a SYN to a blackhole waits on the kernel
# TCP timeout (many minutes per URI).
APT_ACQUIRE_TIMEOUT_SECS="${APT_ACQUIRE_TIMEOUT_SECS:-30}"
# One blip is not a dead mirror. 3 × 30s = 90s per URI, then apt gives up.
APT_ACQUIRE_RETRIES="${APT_ACQUIRE_RETRIES:-3}"
# `apt-get update` only fetches indexes. 3 min is ~90× a healthy InRelease.
APT_UPDATE_TIMEOUT_SECS="${APT_UPDATE_TIMEOUT_SECS:-180}"
# Ceiling for install/upgrade. The first 102052 that finished did the WHOLE
# bootstrap in ~10 min; 15 min for a single apt-get is 1.5× that, still finite.
APT_CMD_TIMEOUT_SECS="${APT_CMD_TIMEOUT_SECS:-900}"
# Ceiling for other bootstrap network commands (git/npm/snap/curl|bash).
NET_CMD_TIMEOUT_SECS="${NET_CMD_TIMEOUT_SECS:-300}"

APT_NETWORK_CONF="/etc/apt/apt.conf.d/99collab-network"

# ---------------------------------------------------------------------------
# configure_apt_network
# Writes apt.conf.d (timeout, retries, ForceIPv4) and replaces the EC2
# regional mirror with the public archive. Idempotent. Must run BEFORE the
# first apt-get — including the pre-flight curl install in install.sh.
# ---------------------------------------------------------------------------
configure_apt_network() {
  mkdir -p /etc/apt/apt.conf.d
  cat > "$APT_NETWORK_CONF" <<EOF
// collab-runtime: apt must never hang the bootstrap.
//
// Timeout ${APT_ACQUIRE_TIMEOUT_SECS}s: a live archive in us-east-1 answers in <2s.
// 30s is slack for a slow mirror. Default apt leaves this unset; a SYN to a
// blackhole then waits on the kernel TCP timeout (measured 32 min on 102052
// with /usr/lib/apt/methods/http alive and zero ESTAB sockets).
// Retries ${APT_ACQUIRE_RETRIES}: one blip (packet loss, 503) is not a dead
// mirror. 3 × Timeout is still well under a minute per URI.
// ForceIPv4: AWS Ubuntu AMIs resolve AAAA for ports/archive.ubuntu.com but a
// typical VPC has no IPv6 route. apt tries IPv6 first; the SYN never
// completes; ss shows no ESTAB. Forcing v4 is the AWS workaround.
Acquire::http::Timeout "${APT_ACQUIRE_TIMEOUT_SECS}";
Acquire::https::Timeout "${APT_ACQUIRE_TIMEOUT_SECS}";
Acquire::Retries "${APT_ACQUIRE_RETRIES}";
Acquire::ForceIPv4 "true";
EOF

  local f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [[ -f "$f" ]] || continue
    if grep -qE 'ec2\.(ports|archive)\.ubuntu\.com' "$f"; then
      # Start on the public archive. The EC2 regional mirror
      # (us-east-1.ec2.ports.ubuntu.com) produced Ign: on two consecutive
      # VMs; keeping it first would cost Timeout seconds on every index file
      # before failover. RTT vs regional is seconds; the hang was unbounded.
      sed -i -E \
        -e 's#https?://[^[:space:]]+\.ec2\.ports\.ubuntu\.com(/ubuntu-ports)?#http://ports.ubuntu.com/ubuntu-ports#g' \
        -e 's#https?://[^[:space:]]+\.ec2\.archive\.ubuntu\.com(/ubuntu)?#http://archive.ubuntu.com/ubuntu#g' \
        "$f"
      echo "[INFO]  apt mirror: replaced EC2 regional URI in ${f} with ports/archive.ubuntu.com"
    fi
  done

  if [[ -z "${_COLLAB_APT_NETWORK_LOGGED:-}" ]]; then
    echo "[INFO]  apt network bounds: Timeout=${APT_ACQUIRE_TIMEOUT_SECS}s Retries=${APT_ACQUIRE_RETRIES} ForceIPv4=true (${APT_NETWORK_CONF})"
    _COLLAB_APT_NETWORK_LOGGED=1
  fi
}

# ---------------------------------------------------------------------------
# run_with_timeout <seconds> <command...>
# Hard ceiling around a network command. GNU timeout 124 (or 137 after
# --kill-after SIGKILL) is logged loudly and returned as 124 so callers can
# tell a hang-kill from a normal command failure.
# Children of apt-get (the http methods) are in the same process group and
# die with it — that is the point; they were the 32-min zombies on 102052.
# ---------------------------------------------------------------------------
run_with_timeout() {
  local secs="$1"
  shift
  local label="$*"
  if ! command_exists timeout; then
    echo "[ERR]  timeout(1) missing; cannot bound: ${label}" >&2
    return 1
  fi
  local rc=0
  timeout --signal=TERM --kill-after=15 "$secs" "$@" || rc=$?
  if (( rc == 124 || rc == 137 )); then
    echo "[ERR]  command exceeded ${secs}s and was killed: ${label}" >&2
    echo "[ERR]  bootstrap must not hang; failing this step" >&2
    return 124
  fi
  return "$rc"
}

# ---------------------------------------------------------------------------
# apt_cmd <apt-get arguments...>
# configure_apt_network + DEBIAN_FRONTEND + shell timeout. `update` uses the
# shorter ceiling; everything else uses APT_CMD_TIMEOUT_SECS.
# ---------------------------------------------------------------------------
apt_cmd() {
  configure_apt_network
  local secs="$APT_CMD_TIMEOUT_SECS"
  if [[ "${1:-}" == "update" ]]; then
    secs="$APT_UPDATE_TIMEOUT_SECS"
  fi
  DEBIAN_FRONTEND=noninteractive run_with_timeout "$secs" apt-get "$@"
}

# ---------------------------------------------------------------------------
# apt_update_safe
# Bounded apt-get update. A timeout or kill FAILS (must not hang, must not
# be swallowed). A non-zero from apt itself (third-party repo 404 on a
# non-LTS Ubuntu) stays a warning so Redis/TimescaleDB skip paths still work.
# ---------------------------------------------------------------------------
apt_update_safe() {
  local rc=0
  apt_cmd update -y || rc=$?
  if (( rc == 0 )); then
    return 0
  fi
  if (( rc == 124 )); then
    echo "[ERR]  apt-get update timed out — failing" >&2
    return 1
  fi
  echo "[WARN]  apt-get update had errors — some repos may not support Ubuntu $(lsb_release -cs 2>/dev/null || echo unknown)" >&2
  echo "[WARN]  Continuing with available package cache from working repositories" >&2
  return 0
}

# ---------------------------------------------------------------------------
# codename_supported <codename> <space-separated-list>
# Returns 0 if codename is in the list, 1 otherwise.
# ---------------------------------------------------------------------------
codename_supported() {
  local codename="$1"
  local list="$2"
  [[ " ${list} " == *" ${codename} "* ]]
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
    local rc=0
    apt_cmd "$@" || rc=$?
    if (( rc == 0 )); then
      return 0
    fi
    if (( rc == 124 )); then
      echo "[ERR]   apt-get $* timed out — not retrying" >&2
      return 1
    fi
    if (( attempt < max_attempts )); then
      echo "[WARN]  apt-get $* failed (attempt ${attempt}/${max_attempts}). Retrying in ${wait_secs}s…" >&2
      sleep "$wait_secs"
      apt_update_safe
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
# Deploy user — one process owner for the whole VM (pm2, msg, mls-base).
#
# collab-sites runs the release as dataOwnerUser (ubuntu). Cloud-init chowns
# /data to that user, then `sudo install.sh` as root, so $USER/$HOME and even
# SUDO_USER are root. The owner of /data is the one source of truth; ubuntu
# is the fallback that matches the AMI and the sites default.
# ---------------------------------------------------------------------------

COLLAB_DATA_ROOT="${COLLAB_DATA_ROOT:-/data}"

# file_owner <path>
# Username that owns the path. GNU stat on the VM; BSD stat so the helper
# can be exercised on macOS. Empty string if the path is missing.
# ---------------------------------------------------------------------------
file_owner() {
  local path="$1"
  [[ -e "$path" ]] || return 0
  local owner=""
  owner="$(stat -c '%U' "$path" 2>/dev/null || true)"
  if [[ -z "$owner" ]]; then
    owner="$(stat -f '%Su' "$path" 2>/dev/null || true)"
  fi
  printf '%s' "$owner"
}

# deploy_home <user>
# Login home for the user. getent on Ubuntu; ~user / conventional paths as
# fallback (macOS has no getent).
# ---------------------------------------------------------------------------
deploy_home() {
  local user="$1"
  local home=""
  if command_exists getent; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" ]]; then
    home="$(eval echo "~${user}" 2>/dev/null || true)"
  fi
  if [[ -z "$home" || "$home" == "~${user}" ]]; then
    if [[ "$user" == "root" ]]; then
      home="/root"
    else
      home="/home/${user}"
    fi
  fi
  printf '%s' "$home"
}

# resolve_deploy_user
# Sets DEPLOY_USER and DEPLOY_HOME. Override with COLLAB_DEPLOY_USER.
# ---------------------------------------------------------------------------
resolve_deploy_user() {
  local owner=""
  if [[ -n "${COLLAB_DEPLOY_USER:-}" ]]; then
    DEPLOY_USER="$COLLAB_DEPLOY_USER"
  else
    owner="$(file_owner "${COLLAB_DATA_ROOT}")"
    if [[ -n "$owner" && "$owner" != "root" ]]; then
      DEPLOY_USER="$owner"
    elif [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
      DEPLOY_USER="$SUDO_USER"
    elif id -u ubuntu &>/dev/null; then
      DEPLOY_USER="ubuntu"
    else
      DEPLOY_USER="${SUDO_USER:-root}"
    fi
  fi
  DEPLOY_HOME="$(deploy_home "$DEPLOY_USER")"
}

# run_as_deploy <command...>
# Run a command as DEPLOY_USER with that user's HOME. Call resolve_deploy_user
# first. Extra env: `run_as_deploy env FOO=bar cmd`.
# ---------------------------------------------------------------------------
run_as_deploy() {
  if [[ -z "${DEPLOY_USER:-}" ]]; then
    resolve_deploy_user
  fi
  if [[ "$(id -un)" == "$DEPLOY_USER" ]]; then
    env PATH="${PATH}:/usr/bin" "$@"
  else
    sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" "$@"
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
  command_exists certbot    && printf "  %-20s %s\n" "certbot"    "$(certbot --version 2>&1 | awk '{print $2}')"
  echo ""
}
