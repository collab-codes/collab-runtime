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

log_section "Step 08 — Install PM2"

if ! command_exists npm; then
  log_error "npm not found. Step 06 (Node.js) must succeed first."
  exit 1
fi

resolve_deploy_user
log_info "PM2 process user: ${DEPLOY_USER} (home ${DEPLOY_HOME})"

# ── Install PM2 ────────────────────────────────────────────────────────────────
if command_exists pm2; then
  log_info "PM2 already installed: $(pm2 --version 2>/dev/null)"
else
  log_info "Installing PM2 globally…"
  run_with_timeout "$NET_CMD_TIMEOUT_SECS" npm install -g pm2
  log_ok "PM2 installed: $(pm2 --version 2>/dev/null)"
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

# ── Register PM2 as a systemd service for the deploy user ─────────────────────
# 'pm2 startup' writes the unit; it must run as root with -u/--hp of the
# deploy user. Never $USER/$HOME of the installer (cloud-init is root).
log_info "Configuring PM2 systemd startup for ${DEPLOY_USER}…"
mkdir -p "${DEPLOY_HOME}/.pm2"
chown "${DEPLOY_USER}:" "${DEPLOY_HOME}/.pm2" 2>/dev/null || true
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" --hp "$DEPLOY_HOME" || \
  log_warn "pm2 startup returned non-zero (may already be configured)"

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
