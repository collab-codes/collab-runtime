#!/bin/bash
# scripts/16-disk-cleanup-timers.sh
# Installs the daily disk cleanup of the VM (rt304): scripts/disk-cleanup.mjs run by two systemd timers.
#   collab-disk-cleanup.timer       every day 02:00 UTC, always;
#   collab-disk-cleanup-boot.timer  10 minutes after boot, and the run does nothing unless the last cleanup finished
#                                   more than 30 hours ago (a VM that was off at 02:00).
# No cron. Idempotent: the same unit text is written every run; the units are reloaded only when a file changed.
# Nothing here starts the cleanup service. The calendar timer is enabled and restarted (a timer restart does not run its
# service); the boot timer is only enabled, because a monotonic timer that is started after its time has passed fires at
# once, and the first run must be the automatic one.
# COLLAB_SYSTEMD_ROOT prefixes /etc (tests); with it set, systemctl is not called.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! declare -F log_info >/dev/null 2>&1; then
  log_section() { echo ""; echo "=== $* ==="; }
  log_info()    { echo "[INFO] $*"; }
  log_ok()      { echo "[OK]   $*"; }
  log_warn()    { echo "[WARN] $*"; }
  log_error()   { echo "[ERR]  $*" >&2; }
fi

log_section "Step 16 — Daily disk cleanup (02:00 UTC, and after boot when the last one is older than 30 h)"

ROOT="${COLLAB_SYSTEMD_ROOT:-}"
UNIT_DIR="${ROOT}/etc/systemd/system"
CLEANUP="${REPO_ROOT}/scripts/disk-cleanup.mjs"
mkdir -p "$UNIT_DIR"

CHANGED=0
write_unit() {
  local name="$1" content="$2"
  local target="${UNIT_DIR}/${name}"
  if [[ -f "$target" && "$(cat "$target")" == "$content" ]]; then return 0; fi
  printf '%s\n' "$content" > "${target}.tmp"
  mv -f "${target}.tmp" "$target"
  CHANGED=1
  log_info "wrote ${target}"
}

write_unit collab-disk-cleanup.service "[Unit]
Description=collab daily disk cleanup

[Service]
Type=oneshot
User=root
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=45min
ExecStart=/usr/bin/env node ${CLEANUP} --trigger=timer"

write_unit collab-disk-cleanup-boot.service "[Unit]
Description=collab disk cleanup after boot (only when the last one is older than 30 h)

[Service]
Type=oneshot
User=root
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=45min
ExecStart=/usr/bin/env node ${CLEANUP} --trigger=boot --if-last-older-than=30h"

write_unit collab-disk-cleanup.timer "[Unit]
Description=collab disk cleanup, every day at 02:00 UTC

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
AccuracySec=1min

[Install]
WantedBy=timers.target"

write_unit collab-disk-cleanup-boot.timer "[Unit]
Description=collab disk cleanup, 10 minutes after boot

[Timer]
OnBootSec=10min

[Install]
WantedBy=timers.target"

if [[ -z "$ROOT" ]] && command -v systemctl >/dev/null 2>&1; then
  if [[ "$CHANGED" -eq 1 ]]; then systemctl daemon-reload; fi
  systemctl enable collab-disk-cleanup.timer
  systemctl enable collab-disk-cleanup-boot.timer
  # restart (not start): on an already active timer `start` keeps the old schedule; restarting a timer never runs the service.
  systemctl restart collab-disk-cleanup.timer
fi

log_ok "Disk cleanup timers installed"
