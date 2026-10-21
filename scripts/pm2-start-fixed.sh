#!/usr/bin/env bash
# Boot PM2 from the two canonical config files. No resurrect, no dump.
# Usage: pm2-start-fixed.sh <pm2-bin> <apps-config> <messages-config>
# Installed copy: /usr/local/lib/collab/pm2-start-fixed.sh
# Runs as the systemd unit user. Does not sudo and does not start a root daemon.
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
  "$pm2_bin" ping
  printf 'pm2-start-fixed: no config present: %s %s\n' "$apps_config" "$messages_config" >&2
  exit 0
fi

if [[ "$start_apps" -eq 1 ]]; then
  "$pm2_bin" start "$apps_config" --update-env
fi

# Drop only the transient deploy flag. The messages config includes msg-worker
# unless that variable is the string "false".
if [[ "$start_messages" -eq 1 ]]; then
  env -u COLLAB_MESSAGES_ENABLE_WORKER "$pm2_bin" start "$messages_config" --update-env
fi
