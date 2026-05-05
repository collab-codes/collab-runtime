#!/bin/bash
# scripts/07-install-7zip.sh
# Installs p7zip-full (7-Zip) and p7zip-rar (RAR support).
# Idempotent: skips if already installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 07 — Install 7-Zip"

if command_exists 7z; then
  log_info "7-Zip already installed: $(7z i 2>&1 | head -2 | tail -1)"
else
  log_info "Installing p7zip-full and p7zip-rar…"
  apt_update_safe
  apt-get install -y p7zip-full p7zip-rar
fi

log_ok "7-Zip: $(7z i 2>&1 | head -2 | tail -1)"
