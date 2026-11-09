#!/bin/bash
# scripts/update-collab-runtime.sh
# Update the management (this checkout of collab-runtime) to origin/main and record the update in the `vm` queue of
# the release record (controleReleases): commit before and after, steps, result, also on failure.
# After the pull it reinstalls the `collab` CLI and the scripts it calls (scripts/install-cli.sh, the same step install.sh
# runs) so an existing VM gets the new CLI too (rt196). It restarts no service: the sites agent has its own path.
#   sudo /data/collab-runtime/scripts/update-collab-runtime.sh
# Git runs as the owner of the checkout (root breaks the fetch). The record is written by mls-base's releaseRecord.mjs;
# without it or without node the update still runs and only a warning is printed.
set -euo pipefail

RUNTIME_DIR="${COLLAB_RUNTIME_DIR:-/data/collab-runtime}"
ETC_DIR="${COLLAB_ETC_DIR:-/data/etc}"
OWNER="$(ls -ld "$RUNTIME_DIR" | awk '{print $3}')"
as_owner() { if [[ "$(id -u)" -eq 0 && "$OWNER" != "root" ]]; then sudo -u "$OWNER" -H "$@"; else "$@"; fi; }

BEFORE="$(as_owner git -C "$RUNTIME_DIR" rev-parse HEAD)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STEPS="pull"
FAIL_STEP="pull"
AFTER="$BEFORE"

# First existing runtime script (rt184): the override, then the project tree of the cm main project (shared.json), then
# any project tree. The shared tree /data/mls-base is no longer a place to look: a new VM never creates it.
find_runtime_script() { # $1 = override path (may be empty), $2 = file name under scripts/runtime
  local override="$1" name="$2" data="${COLLAB_DATA_ROOT:-/data}" main candidate
  if [[ -n "$override" && -f "$override" ]]; then printf '%s' "$override"; return 0; fi
  main="$(sed -n 's/.*"projetoPrincipal"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${COLLAB_ETC_DIR:-${data}/etc}/shared.json" 2>/dev/null | head -n 1)"
  if [[ -n "$main" && -f "${data}/app${main}/mls-base/scripts/runtime/${name}" ]]; then
    printf '%s' "${data}/app${main}/mls-base/scripts/runtime/${name}"; return 0
  fi
  for candidate in "${data}"/app*/mls-base/scripts/runtime/"${name}"; do
    if [[ -f "$candidate" ]]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

record() { # $1 = ok|falhou, $2 = failing step, $3 = message
  local rec=""
  rec="$(find_runtime_script "${COLLAB_RELEASE_RECORD_SCRIPT:-}" releaseRecord.mjs)" || rec=""
  if [[ -z "$rec" ]] || ! command -v node >/dev/null 2>&1; then
    echo "[WARN] release record: releaseRecord.mjs or node not found; skipped" >&2
    return 0
  fi
  node "$rec" vm --antes "$BEFORE" --depois "$AFTER" --repo-dir "$RUNTIME_DIR" --etc "$ETC_DIR" --passos "$STEPS" \
    --inicio "$STARTED_AT" --resultado "$1" --falha "${2:-}" --mensagem "${3:-}" \
    || echo "[WARN] release record not written" >&2
  return 0
}

trap 'rc=$?; trap - EXIT; if [[ $rc -ne 0 ]]; then record falhou "$FAIL_STEP" "update exited with status $rc"; fi; exit $rc' EXIT

as_owner git -C "$RUNTIME_DIR" fetch origin
as_owner git -C "$RUNTIME_DIR" merge --ff-only origin/main
AFTER="$(as_owner git -C "$RUNTIME_DIR" rev-parse HEAD)"
echo "collab-runtime: ${BEFORE:0:7} -> ${AFTER:0:7}"

# The CLI step runs the install-cli.sh of the checkout that was just pulled; an older checkout without it is skipped.
# Needs root (it writes /usr/local); COLLAB_CLI_PREFIX redirects the destinations (tests), so it needs no root then.
CLI_SCRIPT="${RUNTIME_DIR}/scripts/install-cli.sh"
if [[ -f "$CLI_SCRIPT" ]]; then
  if [[ "$(id -u)" -eq 0 || -n "${COLLAB_CLI_PREFIX:-}" ]]; then
    STEPS="pull,cli"
    FAIL_STEP="cli"
    COLLAB_CLI_SRC="$RUNTIME_DIR" bash "$CLI_SCRIPT"
    FAIL_STEP="pull"
  else
    echo "[WARN] not root: the collab CLI was not reinstalled (run with sudo)" >&2
  fi
fi

# The sites agent (rt199): install its files from the checkout just pulled, with the same step as install.sh. The record
# (`pull,cli,agente`) is written BEFORE the restart, and the restart comes LAST, outside this process (a transient systemd
# timer), and only when a file that runs inside the agent changed. An older checkout without vm-update.mjs is skipped.
AGENT_RESTART=0
UPDATE_SCRIPT="${RUNTIME_DIR}/scripts/vm-update.mjs"
if [[ -f "$UPDATE_SCRIPT" ]] && command -v node >/dev/null 2>&1 && { [[ "$(id -u)" -eq 0 ]] || [[ -n "${COLLAB_CLI_PREFIX:-}" ]]; }; then
  STEPS="${STEPS},agente"
  FAIL_STEP="agente"
  AGENT_OUT="$(COLLAB_RUNTIME_DIR="$RUNTIME_DIR" node "$UPDATE_SCRIPT" agente --no-record --no-restart)"
  echo "$AGENT_OUT"
  if printf '%s' "$AGENT_OUT" | grep -q '"reinicio":true'; then AGENT_RESTART=1; fi
  FAIL_STEP="pull"
fi
record ok
trap - EXIT
if [[ "$AGENT_RESTART" -eq 1 ]]; then
  COLLAB_RUNTIME_DIR="$RUNTIME_DIR" node "$UPDATE_SCRIPT" agente --restart-only || echo "[WARN] agent restart not scheduled" >&2
fi
