#!/bin/bash
# scripts/04b-log-retention.sh
# Log retention of the VM: 30 days for the PostgreSQL log and for the systemd journal (rt185).
# The PostgreSQL log of a VM filled 1.9 GB in five days (weekly rotation, no size limit) and the journal grew to
# 1.3 GB (journald default: no time limit). Here: PostgreSQL rotates daily, keeps 30, and rotates at 200 MB; the
# journal keeps 300 MB and 30 days. Idempotent: the same content is written every run.
# COLLAB_RETENTION_ROOT prefixes /etc (tests); with it set, journald is not restarted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"

log_section "Step 04b — Log retention (30 days)"

ROOT="${COLLAB_RETENTION_ROOT:-}"
LOGROTATE_FILE="${ROOT}/etc/logrotate.d/postgresql-common"
JOURNALD_DIR="${ROOT}/etc/systemd/journald.conf.d"

mkdir -p "$(dirname "$LOGROTATE_FILE")" "$JOURNALD_DIR"

cat > "${LOGROTATE_FILE}.tmp" <<'CONF'
/var/log/postgresql/*.log {
       daily
       rotate 30
       maxsize 200M
       copytruncate
       delaycompress
       compress
       notifempty
       missingok
       su root root
}
CONF
mv -f "${LOGROTATE_FILE}.tmp" "$LOGROTATE_FILE"
log_info "logrotate ${LOGROTATE_FILE}: daily, rotate 30, maxsize 200M"

cat > "${JOURNALD_DIR}/collab.conf.tmp" <<'CONF'
[Journal]
SystemMaxUse=300M
MaxRetentionSec=30day
CONF
mv -f "${JOURNALD_DIR}/collab.conf.tmp" "${JOURNALD_DIR}/collab.conf"
log_info "journald ${JOURNALD_DIR}/collab.conf: 300M, 30 days"

if [[ -z "$ROOT" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl restart systemd-journald
fi

log_ok "Log retention configured"
