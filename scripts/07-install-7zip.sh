#!/bin/bash
# scripts/07-install-7zip.sh
# Installs p7zip-full (7-Zip) and p7zip-rar (RAR support).
# Idempotent: skips install if already present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

log_section "Step 07 — Install 7-Zip"

if command_exists 7z; then
  log_info "7-Zip is already installed: $(7z i 2>&1 | head -2 | tail -1)"
else
  log_info "Installing p7zip-full and p7zip-rar…"
  apt-get update -y
  apt_retry 3 install -y p7zip-full p7zip-rar
fi

SEVENZIP_VER="$(7z i 2>&1 | head -2 | tail -1)"
log_ok "7-Zip installed: ${SEVENZIP_VER}"
