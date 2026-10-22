#!/usr/bin/env bash
# Boot PM2 from the two canonical config files. No resurrect, no dump.
# Usage: pm2-start-fixed.sh <pm2-bin> <apps-config> <messages-config>
# Installed copy: /usr/local/lib/collab/pm2-start-fixed.sh
# Runs as the systemd unit user. Does not sudo and does not start a root daemon.
# Holds collab-lifecycle.lock for the guard and every later pm2 invocation.
# One 80s budget covers home validation, the lock wait and every pm2 command.
# It is not restarted per config. Expiry fails closed and keeps the lock until
# a child that might still start apps has been reaped. The unit collects the
# cgroup if this start outlives TimeoutStartSec.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'pm2-start-fixed: usage: pm2-start-fixed.sh <pm2-bin> <apps-config> <messages-config>\n' >&2
  exit 64
fi

pm2_bin=$1
apps_config=$2
messages_config=$3

if [[ ! -x "$pm2_bin" ]]; then
  printf 'pm2-start-fixed: pm2 binary is missing or not executable: %s\n' "$pm2_bin" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lifecycle="${script_dir}/pm2-lifecycle.mjs"

if [[ ! -f "$lifecycle" || ! -r "$lifecycle" ]]; then
  printf 'pm2-start-fixed: lifecycle helper missing or unreadable: %s\n' "$lifecycle" >&2
  exit 1
fi

if [[ -z "${PM2_HOME:-}" ]]; then
  printf 'pm2-start-fixed: PM2_HOME missing\n' >&2
  exit 1
fi

# 80s is inside the unit TimeoutStartSec of 90s. A lower test budget is allowed.
# A higher value is ignored so the budget cannot be raised from the environment.
BUDGET_MS=80000
if [[ "${PM2_START_BUDGET_MS:-}" =~ ^[0-9]+$ ]] && (( PM2_START_BUDGET_MS > 0 && PM2_START_BUDGET_MS < BUDGET_MS )); then
  BUDGET_MS=$PM2_START_BUDGET_MS
fi

PROC=${COLLAB_PROC:-/proc}
case "$PROC" in
  /*) ;;
  *)
    printf 'pm2-start-fixed: COLLAB_PROC must be an absolute proc root\n' >&2
    exit 1
    ;;
esac

mono_ms() {
  python3 -c 'import time; print(int(time.monotonic()*1000))'
}

T0=$(mono_ms)

remain_ms() {
  local now
  now=$(mono_ms)
  echo $(( BUDGET_MS - (now - T0) ))
}

boot_id=-
if [[ -f "$PROC/sys/kernel/random/boot_id" && ! -L "$PROC/sys/kernel/random/boot_id" && -r "$PROC/sys/kernel/random/boot_id" ]]; then
  boot_id=$(tr -d '[:space:]' < "$PROC/sys/kernel/random/boot_id")
  if [[ -z "$boot_id" ]]; then
    boot_id=-
  fi
fi

# Unit cgroup path (the hierarchy entry that names a .service). Empty if absent.
service_cgroup() {
  local file=$1
  local line path
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    path=${line##*:}
    if [[ "$path" == *".service"* ]]; then
      printf '%s\n' "$path"
      return 0
    fi
  done < "$file"
  return 1
}

# Manual invocation has no unit cgroup and must not reach a pm2 command.
unit_cgroup=$(service_cgroup "$PROC/self/cgroup" || true)
if [[ -z "$unit_cgroup" ]]; then
  printf 'pm2-start-fixed: not in a systemd unit cgroup; start with systemctl\n' >&2
  exit 1
fi

phase_begin() {
  PHASE_NAME=$1
  PHASE_MONO=$(mono_ms)
  export PHASE_NAME PHASE_MONO
  printf 'pm2-start-fixed: bootId=%s phase=%s edge=begin mono=%s\n' "$boot_id" "$PHASE_NAME" "$PHASE_MONO" >&2
}

phase_end() {
  local phase=$1
  local code=$2
  local now dur
  now=$(mono_ms)
  dur=$(( now - PHASE_MONO ))
  if (( dur < 0 )); then
    dur=0
  fi
  printf 'pm2-start-fixed: bootId=%s phase=%s edge=end mono=%s durationMs=%s code=%s\n' \
    "$boot_id" "$phase" "$now" "$dur" "$code" >&2
}

# Reap the child before returning. On budget expiry the exit is failure even if
# the child later returns 0, and the caller must not start another config.
# The lock is still held by this shell; it is not released while the child lives.
run_bounded() {
  "$@" &
  local child=$!
  local left
  while true; do
    left=$(remain_ms)
    if (( left <= 0 )); then
      wait "$child" || true
      return 1
    fi
    if ! kill -0 "$child" 2>/dev/null; then
      wait "$child"
      return $?
    fi
    sleep 0.05
  done
}

verify_identity() {
  local pidfile pid daemon_cgroup
  pidfile=${PM2_HOME}/pm2.pid
  [[ -f "$pidfile" && ! -L "$pidfile" && -r "$pidfile" ]] || return 1
  pid=$(tr -d '[:space:]' < "$pidfile")
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -d "$PROC/$pid" && ! -L "$PROC/$pid" ]] || return 1
  daemon_cgroup=$(service_cgroup "$PROC/$pid/cgroup" || true)
  [[ -n "$daemon_cgroup" ]] || return 1
  [[ "$daemon_cgroup" == "$unit_cgroup" || "$daemon_cgroup" == "$unit_cgroup"/* ]] || return 1
  return 0
}

# 0 = present and readable, 2 = absent, 1 = present but unreadable.
classify_config() {
  local config=$1
  if [[ ! -e "$config" ]]; then
    printf 'pm2-start-fixed: config absent: %s\n' "$config" >&2
    return 2
  fi
  if [[ ! -f "$config" || ! -r "$config" ]]; then
    printf 'pm2-start-fixed: config present but unreadable: %s\n' "$config" >&2
    return 1
  fi
  return 0
}

run_starts() {
  local apps_state messages_state start_apps start_messages code left
  # Parent holds the lock. Guard refuses; it does not kill to clear the way.
  phase_begin guard
  code=0
  node "$lifecycle" guard --held || code=$?
  phase_end guard "$code"
  if (( code != 0 )); then
    exit "$code"
  fi

  apps_state=0
  classify_config "$apps_config" || apps_state=$?
  if [[ "$apps_state" -eq 1 ]]; then
    exit 1
  fi

  messages_state=0
  classify_config "$messages_config" || messages_state=$?
  if [[ "$messages_state" -eq 1 ]]; then
    exit 1
  fi

  start_apps=0
  start_messages=0
  if [[ "$apps_state" -eq 0 ]]; then
    start_apps=1
  fi
  if [[ "$messages_state" -eq 0 ]]; then
    start_messages=1
  fi

  # One file passed as both paths is started once.
  if [[ "$start_apps" -eq 1 && "$start_messages" -eq 1 && "$apps_config" == "$messages_config" ]]; then
    start_apps=0
  fi

  if [[ "$start_apps" -eq 0 && "$start_messages" -eq 0 ]]; then
    printf 'pm2-start-fixed: no config present: %s %s\n' "$apps_config" "$messages_config" >&2
    left=$(remain_ms)
    if (( left <= 0 )); then
      printf 'pm2-start-fixed: budget exhausted before ping\n' >&2
      exit 1
    fi
    code=0
    run_bounded "$pm2_bin" ping || code=$?
    if (( code != 0 )); then
      printf 'pm2-start-fixed: ping failed: %s\n' "$code" >&2
      exit "$code"
    fi
  fi

  if [[ "$start_apps" -eq 1 ]]; then
    left=$(remain_ms)
    if (( left <= 0 )); then
      phase_begin apps
      phase_end apps 1
      exit 1
    fi
    phase_begin apps
    code=0
    run_bounded "$pm2_bin" start "$apps_config" --update-env || code=$?
    phase_end apps "$code"
    if (( code != 0 )); then
      exit "$code"
    fi
  fi

  # Drop only the transient deploy flag. The messages config includes msg-worker
  # unless that variable is the string "false".
  if [[ "$start_messages" -eq 1 ]]; then
    left=$(remain_ms)
    if (( left <= 0 )); then
      phase_begin messages
      phase_end messages 1
      exit 1
    fi
    phase_begin messages
    code=0
    run_bounded env -u COLLAB_MESSAGES_ENABLE_WORKER "$pm2_bin" start "$messages_config" --update-env || code=$?
    phase_end messages "$code"
    if (( code != 0 )); then
      exit "$code"
    fi
  fi

  # Command status is not readiness. Success requires the daemon pid in this unit.
  phase_begin done
  code=0
  verify_identity || code=$?
  phase_end done "$code"
  exit "$code"
}

export lifecycle pm2_bin apps_config messages_config
export PROC unit_cgroup boot_id T0 BUDGET_MS
export -f mono_ms remain_ms service_cgroup phase_begin phase_end run_bounded verify_identity classify_config run_starts

phase_begin validate-home
vh=0
node "$lifecycle" validate-home || vh=$?
phase_end validate-home "$vh"
if (( vh != 0 )); then
  exit "$vh"
fi

left=$(remain_ms)
phase_begin lock
if (( left <= 0 )); then
  phase_end lock 1
  exit 1
fi
wait_s=$(python3 -c "print(${left}/1000)")
lock="${PM2_HOME}/collab-lifecycle.lock"
lock_mark="${PM2_HOME}/.collab-lock-entered"
if [[ -L "$lock_mark" ]]; then
  phase_end lock 1
  exit 1
fi
rm -f -- "$lock_mark"
set +e
flock -w "$wait_s" -- "$lock" bash -c 'set -euo pipefail; : > "$PM2_HOME/.collab-lock-entered"; phase_end lock 0; run_starts'
lock_rc=$?
set -e
if [[ ! -f "$lock_mark" ]]; then
  phase_end lock "$lock_rc"
  exit "$lock_rc"
fi
exit "$lock_rc"
