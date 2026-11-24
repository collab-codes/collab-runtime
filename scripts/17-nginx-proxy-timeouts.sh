#!/bin/bash
# scripts/17-nginx-proxy-timeouts.sh
# Writes the VM nginx http-level proxy timeouts (rt308): 1900s, the same wait the platform uses
# above the collab-messages 30 minute LLM proxy. A location block that sets its own timeout still wins.
# Idempotent: the same file is not rewritten and nginx is not reloaded.
# After a write, nginx -t must pass; a failure restores the previous file (or removes the new one)
# and the script exits with the nginx -t message. A passing test reloads nginx (reload, not restart).
# nginx -T must then show the three directives, which only happens when nginx.conf includes conf.d/*.conf
# inside http. No nginx: warn and exit 0.
# COLLAB_NGINX_ROOT prefixes /etc (tests).
set -euo pipefail

if ! declare -F log_info >/dev/null 2>&1; then
  log_section() { echo ""; echo "=== $* ==="; }
  log_info()    { echo "[INFO] $*"; }
  log_ok()      { echo "[OK]   $*"; }
  log_warn()    { echo "[WARN] $*"; }
  log_error()   { echo "[ERR]  $*" >&2; }
fi

log_section "Step 17 — NGINX proxy timeouts (1900s)"

if ! command -v nginx >/dev/null 2>&1; then
  log_warn "nginx is not installed; proxy timeouts skipped"
  exit 0
fi

ROOT="${COLLAB_NGINX_ROOT:-}"
CONF_DIR="${ROOT}/etc/nginx/conf.d"
CONF="${CONF_DIR}/collab-proxy-timeouts.conf"
CONTENT="# managed by collab-runtime step 17
proxy_read_timeout 1900s;   # above collab-messages 30 minute LLM proxy wait
proxy_send_timeout 1900s;
send_timeout 1900s;
"

# $(cat) drops trailing newlines, so the sentinel keeps them and the compare stays in this shell.
file_equals() {
  [[ -f "$1" ]] || return 1
  local data
  data="$(cat "$1"; echo x)"
  [[ "${data%x}" == "$2" ]]
}

if file_equals "$CONF" "$CONTENT"; then
  log_ok "nginx proxy timeouts already set"
  exit 0
fi

mkdir -p "$CONF_DIR"
PREVIOUS=""
HAD_PREVIOUS=0
if [[ -f "$CONF" ]]; then
  data="$(cat "$CONF"; echo x)"
  PREVIOUS="${data%x}"
  HAD_PREVIOUS=1
fi

restore_conf() {
  if [[ "$HAD_PREVIOUS" -eq 1 ]]; then
    printf '%s' "$PREVIOUS" > "${CONF}.tmp"
    mv -f "${CONF}.tmp" "$CONF"
  else
    rm -f "$CONF"
  fi
}

printf '%s' "$CONTENT" > "${CONF}.tmp"
mv -f "${CONF}.tmp" "$CONF"
log_info "wrote ${CONF}"

NGINX_TEST="$(nginx -t 2>&1)" && NGINX_TEST_OK=1 || NGINX_TEST_OK=0
if [[ "$NGINX_TEST_OK" -ne 1 ]]; then
  restore_conf
  log_error "nginx -t failed; ${CONF} restored"
  log_error "$NGINX_TEST"
  exit 1
fi

systemctl reload nginx

NGINX_DUMP="$(nginx -T 2>&1)" || {
  log_error "nginx -T failed"
  log_error "$NGINX_DUMP"
  exit 1
}
missing=""
for directive in "proxy_read_timeout 1900s;" "proxy_send_timeout 1900s;" "send_timeout 1900s;"; do
  if ! printf '%s\n' "$NGINX_DUMP" | grep -F -q "$directive"; then
    missing="${missing} ${directive}"
  fi
done
if [[ -n "$missing" ]]; then
  log_error "nginx -T does not show${missing} (conf.d/*.conf is not included inside http, or the reload did not load ${CONF})"
  exit 1
fi

log_ok "nginx proxy timeouts set to 1900s"
