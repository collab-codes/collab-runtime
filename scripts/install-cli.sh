#!/bin/bash
# scripts/install-cli.sh — install the `collab` CLI and the scripts it calls (rt196).
#
# ONE place for the copy step: install.sh calls it once at install time, and update-collab-runtime.sh calls it after every
# `git pull`, so a VM that already exists gets the new CLI too. Idempotent (a file is copied only when it differs) and it
# never restarts a service: the sites agent has its own path (install-shutdown.sh --restart-agent) because it restarts.
#
#   COLLAB_CLI_SRC     checkout to copy from (default: the checkout this script lives in)
#   COLLAB_CLI_PREFIX  root prefix for the destinations (default empty; tests use a temp dir)
set -euo pipefail

SRC="${COLLAB_CLI_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PREFIX="${COLLAB_CLI_PREFIX:-}"
PREFIX="${PREFIX%/}"
BIN_DIR="${PREFIX}/usr/local/bin"
LIB_DIR="${PREFIX}/usr/local/lib/collab"

if [[ ! -f "${SRC}/collab" ]]; then
  echo "[ERR]  collab CLI source not found at ${SRC}/collab" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$LIB_DIR"
changed=0

put() { # $1 = source, $2 = destination
  if [[ ! -f "$1" ]]; then
    echo "[ERR]  missing source file: $1" >&2
    exit 1
  fi
  if [[ -f "$2" && -x "$2" ]] && cmp -s "$1" "$2"; then
    return 0
  fi
  install -m 0755 "$1" "$2"
  echo "collab CLI: updated $2"
  changed=$((changed + 1))
}

put "${SRC}/collab" "${BIN_DIR}/collab"
put "${SRC}/scripts/11-install-collab-messages.sh" "${LIB_DIR}/install-collab-messages.sh"
for name in msg-configure.mjs msg-vapid.mjs vm-agent.mjs vm-inventory.mjs vm-update.mjs; do
  put "${SRC}/scripts/${name}" "${LIB_DIR}/${name}"
done

if [[ "$changed" -eq 0 ]]; then
  echo "collab CLI: unchanged"
fi
