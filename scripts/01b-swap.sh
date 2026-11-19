#!/bin/bash
# scripts/01b-swap.sh
# 2 GB swap on the VM. A memory spike slows the machine instead of letting the kernel kill the build.
# Idempotent: an active swap is left as it is. COLLAB_SWAP_ROOT prefixes /swapfile and /etc (tests).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"

log_section "Step 01b — Swap (2 GB)"

ROOT="${COLLAB_SWAP_ROOT:-}"
SWAPFILE="${ROOT}/swapfile"
FSTAB="${ROOT}/etc/fstab"
SYSCTL="${ROOT}/etc/sysctl.d/99-collab-swap.conf"
NEED_KIB=$((3 * 1024 * 1024))

if [[ -n "$(swapon --show)" ]]; then
  log_info "swap already active"
  log_ok "Swap left unchanged"
  exit 0
fi

avail_kib="$(df --output=avail / | awk 'NR==2 { print $1 }')"
if [[ ! "$avail_kib" =~ ^[0-9]+$ ]] || (( avail_kib < NEED_KIB )); then
  log_error "not enough free space on / (${avail_kib:-unknown} KiB); need 3 GiB free to create the 2 GB swap"
  exit 1
fi

mkdir -p "$(dirname "$SWAPFILE")" "$(dirname "$SYSCTL")"
if ! fallocate -l 2G "$SWAPFILE"; then
  dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none
fi
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE"
swapon "$SWAPFILE"

fstab_line="${SWAPFILE} none swap sw 0 0"
mkdir -p "$(dirname "$FSTAB")"
touch "$FSTAB"
if ! grep -qxF "$fstab_line" "$FSTAB"; then
  printf '%s\n' "$fstab_line" >> "$FSTAB"
fi
log_info "fstab ${fstab_line}"

printf 'vm.swappiness=10\n' > "$SYSCTL"
sysctl --system
log_info "sysctl ${SYSCTL}: vm.swappiness=10"

log_ok "Swap configured"
