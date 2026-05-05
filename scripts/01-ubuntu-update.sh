#!/bin/bash
# scripts/01-ubuntu-update.sh
# Updates all system packages on Ubuntu 24.04 LTS.
# Idempotent: safe to re-run at any time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 01 — Ubuntu System Update"

log_info "Running apt-get update…"
apt_update_safe

log_info "Running full system upgrade…"
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

log_info "Running dist-upgrade…"
DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y

log_info "Removing unused packages…"
apt-get autoremove -y
apt-get clean

OS_DESC="$(lsb_release -d | cut -f2)"
log_ok "System update complete. OS: ${OS_DESC}"
