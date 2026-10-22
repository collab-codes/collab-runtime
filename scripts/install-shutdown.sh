#!/bin/bash
# Point installer for the ordered shutdown worker and the sites agent modules.
# Copies only. Does not start collab-shutdown, stop services, or edit the agent env.
#
#   scripts/install-shutdown.sh --maintenance-only
#       Refresh the installed copies and collab-shutdown.service, then
#       daemon-reload and systemd-analyze verify.
#   scripts/install-shutdown.sh --maintenance-only --restart-agent
#       Same, then restart collab-sites-agent. Explicit, after the copies
#       are in place. Never starts the shutdown worker.
#
# Test stages set COLLAB_SHUTDOWN_PREFIX, SYSTEMCTL and SYSTEMD_ANALYZE.
# `collab vm shutdown` does not accept a destination or a script path.
set -euo pipefail

MAINTENANCE=0
RESTART_AGENT=0
for arg in "$@"; do
  case "$arg" in
    --maintenance-only) MAINTENANCE=1 ;;
    --restart-agent) RESTART_AGENT=1 ;;
    *)
      echo "[ERR]  unknown argument: ${arg}" >&2
      echo "Usage: install-shutdown.sh --maintenance-only [--restart-agent]" >&2
      exit 2
      ;;
  esac
done

if [[ "$MAINTENANCE" -ne 1 ]]; then
  echo "[ERR]  --maintenance-only is required. This installer does not bootstrap the VM." >&2
  exit 2
fi

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${COLLAB_SHUTDOWN_PREFIX:-}"
PREFIX="${PREFIX%/}"
AGENT_DIR="${PREFIX}/usr/local/lib/collab-sites-agent"
LIB_DIR="${PREFIX}/usr/local/lib/collab"
UNIT_PATH="${PREFIX}/etc/systemd/system/collab-shutdown.service"
WORKER_PATH="${AGENT_DIR}/shutdown-worker.mjs"
LIFECYCLE_PATH="${LIB_DIR}/pm2-lifecycle.mjs"
READONLY_PATH="${LIB_DIR}/pm2-readonly.mjs"
SYSTEMCTL_BIN="${SYSTEMCTL:-systemctl}"
ANALYZE_BIN="${SYSTEMD_ANALYZE:-systemd-analyze}"

copy_file() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "[ERR]  missing source: ${src}" >&2
    exit 1
  fi
  cp "$src" "$dest"
  chmod 644 "$dest"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown 0:0 "$dest"
  fi
}

mkdir -p "$AGENT_DIR" "$LIB_DIR" "$(dirname "$UNIT_PATH")"
chmod 755 "$AGENT_DIR" "$LIB_DIR"

copy_file "${SOURCE_ROOT}/agent/collab-sites-agent.mjs" "${AGENT_DIR}/collab-sites-agent.mjs"
copy_file "${SOURCE_ROOT}/agent/shutdown-state.mjs" "${AGENT_DIR}/shutdown-state.mjs"
copy_file "${SOURCE_ROOT}/agent/shutdown-worker.mjs" "$WORKER_PATH"
copy_file "${SOURCE_ROOT}/agent/shutdown-services.mjs" "${AGENT_DIR}/shutdown-services.mjs"
copy_file "${SOURCE_ROOT}/scripts/pm2-lifecycle.mjs" "$LIFECYCLE_PATH"
copy_file "${SOURCE_ROOT}/scripts/pm2-readonly.mjs" "$READONLY_PATH"

# Checkout imports of the passive reader become the installed copy, prefix included.
retarget_pm2_readonly() {
  local file="$1"
  local required="$2"
  local spec tmp
  spec="\"${READONLY_PATH}\""
  if grep -q "from ${spec}" "$file"; then
    return 0
  fi
  if ! grep -Eq 'from "(\./|\.\./scripts/)pm2-readonly\.mjs"' "$file"; then
    if [[ "$required" -eq 1 ]]; then
      echo "[ERR]  pm2-readonly import missing in ${file}" >&2
      exit 1
    fi
    return 0
  fi
  tmp="$(mktemp "$(dirname "$file")/.pm2-readonly.XXXXXX")"
  sed \
    -e "s#from \"./pm2-readonly.mjs\"#from ${spec}#" \
    -e "s#from \"../scripts/pm2-readonly.mjs\"#from ${spec}#" \
    "$file" > "$tmp"
  mv "$tmp" "$file"
  chmod 644 "$file"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown 0:0 "$file"
  fi
}

retarget_pm2_readonly "$LIFECYCLE_PATH" 1
retarget_pm2_readonly "${AGENT_DIR}/shutdown-services.mjs" 0
retarget_pm2_readonly "${AGENT_DIR}/collab-sites-agent.mjs" 0

# The checkout import is relative to the repo. The installed copy must use the
# stable library path, including a staging prefix when one was injected.
services="${AGENT_DIR}/shutdown-services.mjs"
if ! grep -q 'from "../scripts/pm2-lifecycle.mjs"' "$services"; then
  echo "[ERR]  shutdown-services.mjs has no checkout pm2-lifecycle import to retarget" >&2
  exit 1
fi
replaced="$(mktemp "${AGENT_DIR}/.shutdown-services.XXXXXX")"
sed "s|from \"../scripts/pm2-lifecycle.mjs\"|from \"${LIFECYCLE_PATH}\"|" "$services" > "$replaced"
mv "$replaced" "$services"
chmod 644 "$services"
if [[ "$(id -u)" -eq 0 ]]; then
  chown 0:0 "$services"
fi

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=collab ordered shutdown worker
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env node ${WORKER_PATH} run
Restart=on-failure
RestartSec=5
RuntimeMaxSec=54min
User=root
EOF
chmod 644 "$UNIT_PATH"
if [[ "$(id -u)" -eq 0 ]]; then
  chown 0:0 "$UNIT_PATH"
fi

"$SYSTEMCTL_BIN" daemon-reload
"$ANALYZE_BIN" verify "$UNIT_PATH"

if [[ "$RESTART_AGENT" -eq 1 ]]; then
  "$SYSTEMCTL_BIN" restart collab-sites-agent
fi
