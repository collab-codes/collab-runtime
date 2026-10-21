#!/bin/bash
# scripts/08-install-pm2.sh
# Installs PM2 globally via npm, registers systemd startup for the deploy
# user (the owner of /data, typically ubuntu — never the installer root),
# and configures log rotation. Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/core/logger.sh"
source "${REPO_ROOT}/core/utils.sh"

# Unknown flags fail before any install, migration, or unit edit.
STARTUP_ONLY=0
if [[ $# -gt 1 ]]; then
  log_error "unknown argument: $*"
  exit 64
fi
case "${1:-}" in
  "") ;;
  --startup-only) STARTUP_ONLY=1 ;;
  *)
    log_error "unknown argument: $1"
    exit 64
    ;;
esac

log_section "Step 08 — Install PM2"

if [[ "$STARTUP_ONLY" -eq 1 ]]; then
  if ! command_exists pm2; then
    log_error "pm2 not found. --startup-only does not install PM2."
    exit 1
  fi
else
  if ! command_exists npm; then
    log_error "npm not found. Step 06 (Node.js) must succeed first."
    exit 1
  fi
fi

resolve_deploy_user
log_info "PM2 process user: ${DEPLOY_USER} (home ${DEPLOY_HOME})"

# ── Install PM2 ────────────────────────────────────────────────────────────────
# --startup-only never reaches npm install or `pm2 --version`.
if [[ "$STARTUP_ONLY" -eq 0 ]]; then
  if command_exists pm2; then
    log_info "PM2 already installed: $(pm2 --version 2>/dev/null)"
  else
    log_info "Installing PM2 globally…"
    run_with_timeout "$NET_CMD_TIMEOUT_SECS" npm install -g pm2
    log_ok "PM2 installed: $(pm2 --version 2>/dev/null)"
  fi
fi

# ── systemd units ──────────────────────────────────────────────────────────────
list_pm2_systemd_units() {
  find /etc/systemd/system /lib/systemd/system -maxdepth 1 -name 'pm2-*.service' -printf '%f\n' 2>/dev/null | sort -u
}

pm2_app_names_from_jlist() {
  if ! command_exists node; then
    return 0
  fi
  node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      let apps = [];
      try { apps = JSON.parse(raw || "[]"); } catch { apps = []; }
      if (!Array.isArray(apps)) apps = [];
      for (const a of apps) {
        const n = a && a.name;
        if (typeof n === "string" && n && n !== "pm2-logrotate") process.stdout.write(n + "\n");
      }
    });
  '
}

pm2_root_app_names() {
  if command_exists node; then
    pm2 jlist 2>/dev/null | pm2_app_names_from_jlist || true
    return 0
  fi
  local name
  for name in msg msg-worker; do
    if pm2 describe "$name" &>/dev/null; then
      printf '%s\n' "$name"
    fi
  done
}

wait_pm2_app_online() {
  local user="$1"
  local name="$2"
  local waited=0
  while (( waited < 30 )); do
    if sudo -u "$user" -H env PATH="${PATH}:/usr/bin" pm2 describe "$name" 2>/dev/null | grep -qi 'status.*online'; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Existing VMs registered pm2 as root (installer $USER). Move running apps to
# the deploy user's daemon, then drop pm2-root. Dump is copied first so the
# substitute is ready; the port can only belong to one process, so the old
# apps are stopped only after that, and resurrected on root if the new side
# does not come online.
migrate_pm2_root_if_needed() {
  if [[ "$DEPLOY_USER" == "root" ]]; then
    return 0
  fi
  if [[ ! -f /etc/systemd/system/pm2-root.service && ! -f /lib/systemd/system/pm2-root.service ]]; then
    return 0
  fi

  log_info "Found pm2-root.service — migrating to ${DEPLOY_USER}"
  mkdir -p "${DEPLOY_HOME}/.pm2"
  chown "${DEPLOY_USER}:" "${DEPLOY_HOME}/.pm2"

  pm2 save >/dev/null 2>&1 || true
  if [[ -f /root/.pm2/dump.pm2 ]]; then
    cp -a /root/.pm2/dump.pm2 "${DEPLOY_HOME}/.pm2/dump.pm2"
    chown "${DEPLOY_USER}:" "${DEPLOY_HOME}/.pm2/dump.pm2"
  fi

  # msg appconfig is 600: ubuntu cannot start msg until it owns the tree.
  if [[ -d /data/msg.collab.codes ]]; then
    chown -R "${DEPLOY_USER}:" /data/msg.collab.codes
    if [[ -f /data/msg.collab.codes/node/appconfig.json ]]; then
      chmod 600 /data/msg.collab.codes/node/appconfig.json
    fi
  fi

  local names
  names="$(pm2_root_app_names | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -z "$names" ]]; then
    log_info "pm2-root has no apps — disabling the unit"
    pm2 kill >/dev/null 2>&1 || true
    env PATH="${PATH}:/usr/bin" pm2 unstartup systemd -u root --hp /root >/dev/null 2>&1 || true
    systemctl disable --now pm2-root.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/pm2-root.service /lib/systemd/system/pm2-root.service
    systemctl daemon-reload >/dev/null 2>&1 || true
    log_ok "pm2-root.service removed"
    return 0
  fi

  log_info "Moving pm2 apps to ${DEPLOY_USER}: ${names}"
  pm2 stop all >/dev/null 2>&1 || true

  local resurrect_rc=0
  sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 resurrect || resurrect_rc=$?
  if (( resurrect_rc != 0 )) && [[ -f "${DEPLOY_HOME}/.pm2/dump.pm2" ]]; then
    sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 start "${DEPLOY_HOME}/.pm2/dump.pm2" || resurrect_rc=$?
  fi

  local name
  local failed=""
  for name in $names; do
    if ! wait_pm2_app_online "$DEPLOY_USER" "$name"; then
      failed="${failed} ${name}"
    fi
  done

  if [[ -n "$failed" ]]; then
    log_error "pm2 migrate: new daemon did not bring up:${failed}"
    log_error "Restoring the root daemon from its dump"
    sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 kill >/dev/null 2>&1 || true
    pm2 resurrect >/dev/null 2>&1 || pm2 start /root/.pm2/dump.pm2 >/dev/null 2>&1 || true
    log_error "pm2-root.service left in place. To migrate by hand:"
    log_error "  pm2 save && cp /root/.pm2/dump.pm2 ${DEPLOY_HOME}/.pm2/ && chown -R ${DEPLOY_USER}: ${DEPLOY_HOME}/.pm2"
    log_error "  pm2 stop all && sudo -u ${DEPLOY_USER} -H pm2 resurrect && sudo -u ${DEPLOY_USER} -H pm2 save"
    log_error "  pm2 delete all && pm2 kill && systemctl disable --now pm2-root"
    return 1
  fi

  pm2 delete all >/dev/null 2>&1 || true
  pm2 kill >/dev/null 2>&1 || true
  env PATH="${PATH}:/usr/bin" pm2 unstartup systemd -u root --hp /root >/dev/null 2>&1 || true
  systemctl disable --now pm2-root.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/pm2-root.service /lib/systemd/system/pm2-root.service
  systemctl daemon-reload >/dev/null 2>&1 || true
  sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 save >/dev/null 2>&1 || true
  log_ok "pm2 apps now on ${DEPLOY_USER}: ${names}"
}

assert_one_pm2_unit() {
  local units count
  units="$(list_pm2_systemd_units)"
  if [[ -z "$units" ]]; then
    log_error "expected exactly one pm2 systemd unit, found none"
    exit 1
  fi
  count="$(printf '%s\n' "$units" | grep -c .)"
  if (( count != 1 )); then
    log_error "expected exactly one pm2 systemd unit, found ${count}: $(printf '%s' "$units" | tr '\n' ' ')"
    exit 1
  fi
  log_ok "pm2 systemd unit: ${units}"
}

# Publish a complete file or leave the previous one untouched.
write_atomic_file() {
  local dest="$1"
  local mode="$2"
  local content="$3"
  local dir tmp
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  tmp="$(mktemp "${dir}/.tmp.XXXXXX")"
  if ! printf '%s\n' "$content" > "$tmp"; then
    rm -f "$tmp"
    log_error "failed to write ${dest}"
    exit 1
  fi
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

# Drop-in, not the unit: `pm2 startup` rewrites the unit and would drop any
# edit. RequiresMountsFor the configured data root so boot does not race
# the EBS mount. fstab keeps nofail so a missing volume still boots.
# COLLAB_SYSTEMD_ETC is a test seam; production stays on /etc.
write_pm2_data_mount_dropin() {
  local unit="pm2-${DEPLOY_USER}.service"
  local dropin_dir="/etc/systemd/system/${unit}.d"
  if [[ -n "${COLLAB_SYSTEMD_ETC:-}" ]]; then
    dropin_dir="${COLLAB_SYSTEMD_ETC}/${unit}.d"
  fi
  mkdir -p "$dropin_dir"
  local tmp
  tmp="$(mktemp "${dropin_dir}/data-mount.conf.XXXXXX")"
  cat > "$tmp" <<EOF
[Unit]
RequiresMountsFor=${COLLAB_DATA_ROOT}
EOF
  mv -f "$tmp" "${dropin_dir}/data-mount.conf"
  log_info "systemd drop-in ${dropin_dir}/data-mount.conf RequiresMountsFor=${COLLAB_DATA_ROOT}"
}

pm2_deploy_unit_path() {
  local unit="pm2-${DEPLOY_USER}.service"
  local etc="${COLLAB_SYSTEMD_ETC:-/etc/systemd/system}"
  local lib="${COLLAB_SYSTEMD_LIB:-/lib/systemd/system}"
  if [[ -f "${etc}/${unit}" ]]; then
    printf '%s' "${etc}/${unit}"
    return 0
  fi
  if [[ -f "${lib}/${unit}" ]]; then
    printf '%s' "${lib}/${unit}"
    return 0
  fi
  return 1
}

# User and PM2_HOME in the generated unit must be the deploy user's daemon.
assert_unit_matches_deploy_daemon() {
  local unit_path="$1"
  local user_line="" line="" ok=0
  user_line="$(grep -E '^User=' "$unit_path" | head -n 1 || true)"
  if [[ "$user_line" != "User=${DEPLOY_USER}" ]]; then
    log_error "pm2 unit User does not match deploy user ${DEPLOY_USER}: ${unit_path}"
    exit 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "Environment=PM2_HOME=${DEPLOY_HOME}/.pm2"|\
      "Environment=\"PM2_HOME=${DEPLOY_HOME}/.pm2\""|\
      "Environment=PM2_HOME=\"${DEPLOY_HOME}/.pm2\"")
        ok=1
        ;;
    esac
  done < "$unit_path"
  if [[ "$ok" -ne 1 ]]; then
    log_error "pm2 unit PM2_HOME does not match ${DEPLOY_HOME}/.pm2: ${unit_path}"
    exit 1
  fi
}

# Binary recorded by pm2 startup on this unit. Not `pm2` from a different home.
pm2_bin_from_unit() {
  local unit_path="$1"
  local line="" rest="" token=""
  line="$(grep -E '^ExecStart=.+' "$unit_path" | head -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  rest="${line#ExecStart=}"
  rest="${rest#"${rest%%[![:space:]]*}"}"
  if [[ "$rest" == \"* ]]; then
    token="${rest:1}"
    token="${token%%\"*}"
  else
    token="${rest%%[[:space:]]*}"
  fi
  if [[ "$token" == /* && -x "$token" && "$token" != *pm2-start-fixed.sh ]]; then
    printf '%s' "$token"
    return 0
  fi
  return 1
}

quote_exec_arg() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

# Root-owned copy. The unit user can execute or read it; deploy cannot rewrite it.
install_rooted_copy() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  local tmp
  if [[ ! -f "$src" ]]; then
    log_error "pm2 lifecycle file is missing: ${src}"
    exit 1
  fi
  tmp="$(mktemp "${dest}.XXXXXX")"
  cp "$src" "$tmp"
  chmod "$mode" "$tmp"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown root: "$tmp"
  fi
  mv -f "$tmp" "$dest"
  log_info "installed ${dest}"
}

install_pm2_fixed_helper() {
  local lib_dir="/usr/local/lib/collab"
  if [[ -n "${COLLAB_LIB_DIR:-}" ]]; then
    lib_dir="$COLLAB_LIB_DIR"
  fi
  if ! command -v node >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
    log_error "node and flock must already be installed; refusing to fetch them"
    exit 1
  fi
  mkdir -p "$lib_dir"
  install_rooted_copy "${SCRIPT_DIR}/pm2-start-fixed.sh" "${lib_dir}/pm2-start-fixed.sh" 0755
  install_rooted_copy "${SCRIPT_DIR}/pm2-lifecycle.mjs" "${lib_dir}/pm2-lifecycle.mjs" 0644
}

# Clears startup ExecStart (resurrect) and ExecStop (pm2 kill).
# Does not set Type, PIDFile, User, or ExecReload.
write_pm2_fixed_configs_dropin() {
  local pm2_bin="$1"
  local unit="pm2-${DEPLOY_USER}.service"
  local dropin_dir="/etc/systemd/system/${unit}.d"
  local lib_dir="/usr/local/lib/collab"
  local helper lifecycle node_bin apps messages body exec_line exec_stop
  if [[ -n "${COLLAB_SYSTEMD_ETC:-}" ]]; then
    dropin_dir="${COLLAB_SYSTEMD_ETC}/${unit}.d"
  fi
  if [[ -n "${COLLAB_LIB_DIR:-}" ]]; then
    lib_dir="$COLLAB_LIB_DIR"
  fi
  node_bin="$(command -v node)"
  helper="${lib_dir}/pm2-start-fixed.sh"
  lifecycle="${lib_dir}/pm2-lifecycle.mjs"
  apps="${COLLAB_DATA_ROOT}/mls-base/pm2.config.js"
  messages="${COLLAB_DATA_ROOT}/msg.collab.codes/pm2.config.js"
  exec_line="ExecStart=$(quote_exec_arg "$helper") $(quote_exec_arg "$pm2_bin") $(quote_exec_arg "$apps") $(quote_exec_arg "$messages")"
  exec_stop="ExecStop=$(quote_exec_arg "$node_bin") $(quote_exec_arg "$lifecycle") stop $(quote_exec_arg "$pm2_bin")"
  body="[Service]
ExecStart=
${exec_line}
ExecStop=
${exec_stop}
TimeoutStopSec=900s"
  write_atomic_file "${dropin_dir}/fixed-configs.conf" 0644 "$body"
  log_info "systemd drop-in ${dropin_dir}/fixed-configs.conf"
}

reload_and_validate_pm2_unit() {
  local unit="pm2-${DEPLOY_USER}.service"
  if ! systemctl daemon-reload; then
    log_error "systemctl daemon-reload failed"
    exit 1
  fi
  if ! systemd-analyze verify "$unit"; then
    log_error "systemd-analyze verify failed for ${unit}"
    exit 1
  fi
}

apply_pm2_fixed_startup() {
  local unit_path="" pm2_bin=""
  if ! unit_path="$(pm2_deploy_unit_path)"; then
    log_error "pm2 systemd unit for ${DEPLOY_USER} is missing"
    exit 1
  fi
  assert_unit_matches_deploy_daemon "$unit_path"
  if ! pm2_bin="$(pm2_bin_from_unit "$unit_path")"; then
    log_error "effective pm2 binary is missing from ${unit_path}"
    exit 1
  fi
  install_pm2_fixed_helper
  write_pm2_data_mount_dropin
  write_pm2_fixed_configs_dropin "$pm2_bin"
  reload_and_validate_pm2_unit
}

# Existing unit only: helper, both drop-ins, daemon-reload, verify.
# No npm install, pm2 startup, root migration, kill/save/reload/restart, or logrotate.
if [[ "$STARTUP_ONLY" -eq 1 ]]; then
  apply_pm2_fixed_startup
  log_ok "PM2 fixed startup drop-ins applied for ${DEPLOY_USER}"
  exit 0
fi

# ── Register PM2 as a systemd service for the deploy user ─────────────────────
# 'pm2 startup' writes the unit; it must run as root with -u/--hp of the
# deploy user. Never $USER/$HOME of the installer (cloud-init is root).
log_info "Configuring PM2 systemd startup for ${DEPLOY_USER}…"
mkdir -p "${DEPLOY_HOME}/.pm2"
chown "${DEPLOY_USER}:" "${DEPLOY_HOME}/.pm2" 2>/dev/null || true
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" --hp "$DEPLOY_HOME" || \
  log_warn "pm2 startup returned non-zero (may already be configured)"
apply_pm2_fixed_startup

if ! migrate_pm2_root_if_needed; then
  exit 1
fi

# `pm2 startup` as root can spawn an empty root daemon even when the unit is
# for ubuntu. Kill it so the only live daemon is the deploy user's.
if [[ "$DEPLOY_USER" != "root" ]] && [[ ! -f /etc/systemd/system/pm2-root.service ]]; then
  pm2 kill >/dev/null 2>&1 || true
fi

# ── Log rotation (talks to the deploy user's daemon) ───────────────────────────
log_info "Installing pm2-logrotate as ${DEPLOY_USER}…"
if [[ "$(id -un)" == "$DEPLOY_USER" ]]; then
  run_with_timeout "$NET_CMD_TIMEOUT_SECS" pm2 install pm2-logrotate 2>/dev/null || log_warn "pm2-logrotate already installed or failed"
  pm2 set pm2-logrotate:max_size 100M  2>/dev/null || true
  pm2 set pm2-logrotate:retain 10      2>/dev/null || true
  pm2 set pm2-logrotate:compress false 2>/dev/null || true
  pm2 save >/dev/null 2>&1 || true
else
  run_with_timeout "$NET_CMD_TIMEOUT_SECS" sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 install pm2-logrotate 2>/dev/null || log_warn "pm2-logrotate already installed or failed"
  sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 set pm2-logrotate:max_size 100M  2>/dev/null || true
  sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 set pm2-logrotate:retain 10      2>/dev/null || true
  sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 set pm2-logrotate:compress false 2>/dev/null || true
  sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" pm2 save >/dev/null 2>&1 || true
fi

assert_one_pm2_unit

log_ok "PM2 $(pm2 --version 2>/dev/null) ready — systemd startup enabled for ${DEPLOY_USER}"
log_info "Tip: after starting apps run 'sudo -u ${DEPLOY_USER} -H pm2 save' to persist the process list"
