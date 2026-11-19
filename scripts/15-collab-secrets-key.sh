#!/bin/bash
# scripts/15-collab-secrets-key.sh
# The VM key for external-system secrets (rt263): one file, outside the repository, and its path in each app .env.
#
# What it does (idempotent; a re-run does not replace a key that is already there):
#   1. /data/etc/collab-secrets.key — 32 raw bytes, only when the file is missing or empty.
#      Owner is the deploy user (the same user pm2 runs as), mode 0600. The bytes are never printed.
#   2. COLLAB_SECRETS_KEY_FILE in each app .env (app*/mls-base/.env and mls-base/.env), the same
#      place as the other runtime variables. The next release copies that .env; this step does not
#      restart pm2.
#
#   sudo bash scripts/15-collab-secrets-key.sh [<env file> ...]
# Without arguments the .env files are found under ${COLLAB_DATA_ROOT:-/data}.
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
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

DATA_ROOT="${COLLAB_DATA_ROOT:-/data}"
ETC_DIR="${COLLAB_ETC_DIR:-${DATA_ROOT}/etc}"
KEY_FILE="${ETC_DIR}/collab-secrets.key"
ENV_VAR="COLLAB_SECRETS_KEY_FILE"
KEY_BYTES=32

log_section "Step 15 — VM key for external secrets"

resolve_deploy_user

if [[ -s "$KEY_FILE" ]]; then
  size="$(wc -c < "$KEY_FILE" | tr -d ' ')"
  if [[ "$size" != "$KEY_BYTES" ]]; then
    log_warn "${KEY_FILE} is ${size} bytes, not ${KEY_BYTES} — left untouched"
  else
    log_info "key already in ${KEY_FILE} — keeping it"
  fi
else
  install -d -m 0755 "$ETC_DIR"
  ( umask 077; head -c "$KEY_BYTES" /dev/urandom > "$KEY_FILE" )
  log_ok "key generated at ${KEY_FILE} (${KEY_BYTES} bytes)"
fi

chmod 600 "$KEY_FILE"
chown "${DEPLOY_USER}:" "$KEY_FILE"
log_ok "${KEY_FILE} owner ${DEPLOY_USER}, mode 600"

env_value() { # $1 = file, $2 = key
  sed -n "s/^$2=//p" "$1" | head -n 1
}

set_env_path() { # $1 = env file
  local file="$1" current tmp
  current="$(env_value "$file" "$ENV_VAR")"
  if [[ "$current" == "$KEY_FILE" ]]; then
    log_info "${file}: ${ENV_VAR} already right"
    return 0
  fi
  tmp="$(mktemp)"
  grep -v "^${ENV_VAR}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$ENV_VAR" "$KEY_FILE" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
  log_ok "${file}: ${ENV_VAR} set"
}

if [[ "$#" -gt 0 ]]; then
  env_files=("$@")
else
  shopt -s nullglob
  env_files=( "${DATA_ROOT}"/app*/mls-base/.env )
  shopt -u nullglob
  if [[ -f "${DATA_ROOT}/mls-base/.env" ]]; then
    env_files+=("${DATA_ROOT}/mls-base/.env")
  fi
fi

if [[ "${#env_files[@]}" -eq 0 ]]; then
  log_warn "no app .env found under ${DATA_ROOT} — pass the file(s) as arguments"
else
  for env_file in "${env_files[@]}"; do
    if [[ -f "$env_file" ]]; then
      set_env_path "$env_file"
    else
      log_warn "${env_file} not found — skipped"
    fi
  done
fi

log_ok "Step 15 done. The next release (or a restart) of each app carries ${ENV_VAR}."
