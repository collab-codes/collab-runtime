#!/bin/bash
# scripts/00-setup-data-disk.sh
# Detects a single blank, unmounted additional disk, asks for confirmation,
# formats it ext4 and mounts it permanently at /data (via /etc/fstab, by UUID).
#
# Conservative by design — it will only ever format a disk that is provably
# safe to format:
#   - Never touches the OS / root disk.
#   - Only formats a completely BLANK disk (no filesystem, no partitions).
#   - Aborts (without formatting) when the situation is ambiguous:
#       * more than one unmounted candidate disk, or
#       * the candidate already contains data / a filesystem / partitions.
#   - Requires interactive "yes" confirmation on a TTY before formatting.
#
# Idempotent: if /data is already a mounted filesystem, it does nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

MOUNT_POINT="/data"
FS_TYPE="ext4"
FS_LABEL="collab-data"

log_section "Step 00 — Setup data disk (${MOUNT_POINT})"

# ── Idempotency: already mounted? ──────────────────────────────────────────────
if mountpoint -q "$MOUNT_POINT"; then
  log_ok "${MOUNT_POINT} is already a mounted filesystem — nothing to do"
  exit 0
fi

# ── Identify the physical disk(s) hosting the root filesystem ──────────────────
# Walk the device tree upward from "/" so this works for plain partitions and
# LVM/dm setups alike. The OS disk(s) are excluded from formatting.
root_source="$(findmnt -no SOURCE / 2>/dev/null || true)"
declare -A IS_ROOT_DISK=()
if [[ -n "$root_source" ]]; then
  while read -r name type; do
    [[ "$type" == "disk" ]] && IS_ROOT_DISK["$name"]=1
  done < <(lsblk -srno NAME,TYPE "$root_source" 2>/dev/null || true)
fi
if [[ ${#IS_ROOT_DISK[@]} -eq 0 ]]; then
  log_error "Could not determine the OS/root disk — aborting for safety"
  exit 1
fi

# ── Enumerate candidate disks: whole disks, not root, nothing mounted ──────────
candidates=()
while read -r disk; do
  [[ -n "$disk" ]] || continue
  [[ -n "${IS_ROOT_DISK[$disk]:-}" ]] && continue            # skip the OS disk
  # Any mountpoint on the disk or its partitions (incl. [SWAP]) => in use.
  if lsblk -nro MOUNTPOINT "/dev/$disk" 2>/dev/null | grep -q '[^[:space:]]'; then
    continue
  fi
  candidates+=("$disk")
done < <(lsblk -dnro NAME,TYPE | awk '$2=="disk"{print $1}')

n=${#candidates[@]}

# ── 0 candidates: nothing to do (not an error) ─────────────────────────────────
if (( n == 0 )); then
  log_warn "No additional unmounted disk found — skipping ${MOUNT_POINT} setup"
  log_info "If you expected one, attach the volume and re-run the installer."
  exit 0
fi

# ── >1 candidates: ambiguous → refuse to format automatically ──────────────────
if (( n > 1 )); then
  log_warn "Found ${n} unmounted disks — ambiguous, refusing to format automatically:"
  for d in "${candidates[@]}"; do
    log_warn "  • /dev/${d}  ($(lsblk -dno SIZE "/dev/$d" 2>/dev/null | tr -d ' '))"
  done
  log_warn "Set up the data disk manually, then re-run scripts/00-setup-data-disk.sh"
  exit 1
fi

DISK="${candidates[0]}"
DEV="/dev/${DISK}"
SIZE="$(lsblk -dno SIZE "$DEV" 2>/dev/null | tr -d ' ')"

# ── Refuse to format a disk that is not blank ──────────────────────────────────
# Blank = no filesystem signature anywhere AND no partition table / children.
existing_fs="$(lsblk -nro FSTYPE "$DEV" 2>/dev/null | grep -v '^$' || true)"
child_count="$(lsblk -nro NAME "$DEV" 2>/dev/null | tail -n +2 | grep -c . || true)"
if [[ -n "$existing_fs" || "${child_count:-0}" -gt 0 ]]; then
  log_warn "${DEV} (${SIZE}) is not blank — it already contains data:"
  lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT "$DEV" || true
  log_warn "Refusing to format a non-empty disk. Wipe it manually if intended:"
  log_warn "  wipefs -a ${DEV}   # WARNING: DESTROYS ALL DATA ON ${DEV}"
  exit 1
fi

# ── Require interactive confirmation on a TTY before formatting ────────────────
if [[ ! -r /dev/tty ]]; then
  log_warn "No interactive terminal available — skipping automatic format of ${DEV}"
  log_warn "Run scripts/00-setup-data-disk.sh manually to set up ${MOUNT_POINT}"
  exit 0
fi

echo ""
log_warn "About to FORMAT ${DEV} (${SIZE}) as ${FS_TYPE} and mount it at ${MOUNT_POINT}."
log_warn "ALL DATA ON ${DEV} WILL BE ERASED."
printf "Type 'yes' to continue (anything else aborts): " > /dev/tty
read -r reply < /dev/tty
if [[ "$reply" != "yes" ]]; then
  log_info "Aborted by user — ${DEV} left untouched"
  exit 0
fi

# ── Format ─────────────────────────────────────────────────────────────────────
log_info "Formatting ${DEV} as ${FS_TYPE} (label: ${FS_LABEL})…"
mkfs."${FS_TYPE}" -F -L "$FS_LABEL" "$DEV"

# ── Mount point ────────────────────────────────────────────────────────────────
ensure_dir "$MOUNT_POINT" 755

# ── Persist in /etc/fstab by UUID (survives reboots & device renames) ──────────
UUID="$(blkid -s UUID -o value "$DEV" 2>/dev/null || true)"
if [[ -z "$UUID" ]]; then
  log_error "Could not read UUID of ${DEV} after format — aborting"
  exit 1
fi

FSTAB_LINE="UUID=${UUID}  ${MOUNT_POINT}  ${FS_TYPE}  defaults,nofail  0  2"

# Replace any previous entry for this mount point, then append the fresh one.
# '#' is used as the sed delimiter so the slashes in the path need no escaping.
if grep -qE "[[:space:]]${MOUNT_POINT}[[:space:]]" /etc/fstab; then
  log_info "Replacing previous ${MOUNT_POINT} entry in /etc/fstab (backup: /etc/fstab.bak)"
  sed -i.bak "\\#[[:space:]]${MOUNT_POINT}[[:space:]]#d" /etc/fstab
fi
echo "$FSTAB_LINE" >> /etc/fstab
log_info "Added to /etc/fstab: ${FSTAB_LINE}"

# ── Mount now and verify ───────────────────────────────────────────────────────
systemctl daemon-reload 2>/dev/null || true
mount "$MOUNT_POINT"

if mountpoint -q "$MOUNT_POINT"; then
  log_ok "${DEV} mounted at ${MOUNT_POINT} (UUID=${UUID}) — persists across reboots"
  df -h "$MOUNT_POINT" | sed 's/^/    /'
else
  log_error "Mount verification failed for ${MOUNT_POINT}"
  exit 1
fi
