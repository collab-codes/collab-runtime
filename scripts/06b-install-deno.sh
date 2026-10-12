#!/bin/bash
# scripts/06b-install-deno.sh
# Installs Deno from the official release zip — system-wide (/usr/local/bin),
# not ~/.deno and not nvm/asdf. DENO_VERSION comes from the active profile
# (default: 2). Idempotent: skips when that major is already installed.
# Runs after Node. Deno does not replace Node.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

DENO_VERSION="${DENO_VERSION:-2}"

# Official asset triple from `uname -m`. Lima on the Mac Mini is aarch64;
# the production VM is x86_64. Both use the linux-gnu zip, never the macOS one.
deno_asset_target() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64)
      printf '%s\n' "x86_64-unknown-linux-gnu"
      ;;
    aarch64|arm64)
      printf '%s\n' "aarch64-unknown-linux-gnu"
      ;;
    *)
      log_error "unsupported architecture for Deno: ${machine}"
      return 1
      ;;
  esac
}

# Major only (the profile default "2") tracks latest. A minor/patch pins the tag.
deno_release_url() {
  local target="$1"
  local ver="${DENO_VERSION:-2}"
  if [[ "$ver" == *.* ]]; then
    local tag="$ver"
    [[ "$tag" == v* ]] || tag="v${tag}"
    printf '%s\n' "https://github.com/denoland/deno/releases/download/${tag}/deno-${target}.zip"
  else
    printf '%s\n' "https://github.com/denoland/deno/releases/latest/download/deno-${target}.zip"
  fi
}

# First line of `deno --version` (e.g. "deno 2.1.4 (release, …)").
# Captured whole: `head` under pipefail dies with SIGPIPE (141) and aborts the step.
deno_version_line() {
  local out
  out="$(deno --version)"
  printf '%s\n' "${out%%$'\n'*}"
}

deno_installed_major() {
  local line
  line="$(deno_version_line)"
  printf '%s\n' "$line" | sed -n 's/^deno \([0-9][0-9]*\).*/\1/p'
}

deno_expected_major() {
  local ver="${DENO_VERSION:-2}"
  ver="${ver#v}"
  printf '%s\n' "${ver%%.*}"
}

# 0 when `deno` is on PATH and its major is the one the profile asked for.
deno_major_matches() {
  command_exists deno || return 1
  local current expected
  current="$(deno_installed_major)"
  expected="$(deno_expected_major)"
  [[ -n "$current" && "$current" == "$expected" ]]
}

install_deno() {
  log_section "Step 06b — Install Deno ${DENO_VERSION}"

  if deno_major_matches; then
    log_info "Deno $(deno_version_line) already installed (major $(deno_expected_major))"
    exit 0
  fi

  if command_exists deno; then
    log_info "Found Deno $(deno_version_line) — replacing with ${DENO_VERSION}…"
  fi

  # 7zip is step 07, which runs after this one. unzip is the prerequisite.
  log_info "Installing prerequisite (unzip)…"
  apt_retry 3 install -y unzip

  local target url
  target="$(deno_asset_target)"
  url="$(deno_release_url "$target")"
  log_info "Downloading Deno ${DENO_VERSION} (${target})…"
  run_with_timeout "$NET_CMD_TIMEOUT_SECS" \
    curl -fsSL --max-time 120 -o /tmp/deno.zip "$url"
  unzip -o /tmp/deno.zip -d /usr/local/bin/
  chmod 755 /usr/local/bin/deno
  log_ok "Deno installed: $(deno_version_line)"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_deno
fi
