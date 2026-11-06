#!/bin/bash
# scripts/11-install-collab-messages.sh
# Install or update collab-messages (the 'msg' pm2 app) from the public S3
# release published by collab-messages/publishCollabMessages.sh:
#   - downloads the latest release (nodefiles.7z, package.json,
#     pnpm-workspace.yaml, pnpm-lock.yaml, pm2.config.js, addNewVersion) from
#     s3://www.collab.codes/collab-messages/ (public,
#     path-style URL — no AWS credentials needed on the VM)
#   - creates a basic /data/msg.collab.codes/node/appconfig.json if missing
#     (real credentials must be filled in later)
#   - runs addNewVersion --updatePackage (release layout + pm2 startOrReload)
#   - exposes /msg on nginx, proxied to 127.0.0.1:8180
# Idempotent: safe to re-run; a re-run with the same version is a no-op unless
# --force is passed. Also used by 'collab msg update' (it copies itself to
# /usr/local/lib/collab/ so the CLI can run it without the repo checkout).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Self-contained: source core helpers from the repo checkout, from the copy
# next to this script (/usr/local/lib/collab), or from the runtime checkout.
_loaded_utils=false
for _candidate in \
  "${REPO_ROOT}/core/utils.sh" \
  "${SCRIPT_DIR}/utils.sh" \
  "/data/collab-runtime/core/utils.sh"
do
  if [[ -f "$_candidate" ]]; then
    _dir="$(cd "$(dirname "$_candidate")" && pwd)"
    if [[ -f "${_dir}/logger.sh" ]]; then
      source "${_dir}/logger.sh"
    fi
    source "$_candidate"
    _loaded_utils=true
    break
  fi
done
unset _candidate _dir
if [[ "$_loaded_utils" != true ]]; then
  resolve_deploy_user() {
    if [[ -n "${COLLAB_DEPLOY_USER:-}" ]]; then
      DEPLOY_USER="$COLLAB_DEPLOY_USER"
    elif [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
      DEPLOY_USER="$SUDO_USER"
    elif id -u ubuntu &>/dev/null; then
      DEPLOY_USER="ubuntu"
    else
      DEPLOY_USER="${SUDO_USER:-root}"
    fi
    DEPLOY_HOME="$(eval echo "~${DEPLOY_USER}")"
  }
  run_as_deploy() {
    if [[ "$(id -un)" == "$DEPLOY_USER" ]]; then
      env PATH="${PATH}:/usr/bin" "$@"
    else
      sudo -u "$DEPLOY_USER" -H env PATH="${PATH}:/usr/bin" "$@"
    fi
  }
fi
unset _loaded_utils
if ! declare -F log_info >/dev/null 2>&1; then
  log_section() { echo ""; echo "=== $* ==="; }
  log_info()    { echo "[INFO] $*"; }
  log_ok()      { echo "[OK]   $*"; }
  log_warn()    { echo "[WARN] $*"; }
  log_error()   { echo "[ERR]  $*" >&2; }
fi

log_section "Step 11 — collab-messages (msg)"

resolve_deploy_user
log_info "collab-messages process user: ${DEPLOY_USER}"

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) log_error "Unknown option: $arg. Usage: $0 [--force]"; exit 1 ;;
  esac
done

S3_BASE="${COLLAB_MESSAGES_S3_BASE:-https://s3.amazonaws.com/www.collab.codes/collab-messages}"
ROOT="${COLLAB_MESSAGES_DEPLOY_ROOT:-/data/msg.collab.codes}"
INSTALL_DIR_MSG="$ROOT/install"
NODE_DIR="$ROOT/node"
VERSION_FILE="$NODE_DIR/collab-messages.version"
CLI_LIB_DIR="/usr/local/lib/collab"

# AWS SDK for `collab msg configure` (no AWS CLI). Prefer the collab-messages
# node_modules; current releases ship @aws-sdk/client-sts but not client-ssm,
# so fall back to installing both next to the CLI script. Versions stay in
# sync with collab-runtime/package.json.
ensure_msg_configure_sdk() {
  mkdir -p "$CLI_LIB_DIR"
  local msg_nm="${NODE_DIR}/node_modules"
  if [[ -d "${msg_nm}/@aws-sdk/client-sts" && -d "${msg_nm}/@aws-sdk/client-ssm" ]]; then
    log_info "msg-configure AWS SDK: ${msg_nm}"
    return 0
  fi
  if [[ -d "${CLI_LIB_DIR}/node_modules/@aws-sdk/client-sts" && -d "${CLI_LIB_DIR}/node_modules/@aws-sdk/client-ssm" ]]; then
    log_info "msg-configure AWS SDK: ${CLI_LIB_DIR}/node_modules"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    log_error "npm not found — run step 06 (Node.js) before configuring collab-messages"
    return 1
  fi
  log_info "Installing @aws-sdk/client-sts and @aws-sdk/client-ssm for msg-configure (no AWS CLI)"
  npm install --prefix "$CLI_LIB_DIR" --omit=dev --no-fund --no-audit --no-progress \
    "@aws-sdk/client-sts@^3.1127.0" \
    "@aws-sdk/client-ssm@^3.744.0"
}

# ── Resolve latest version ─────────────────────────────────────────────────────
log_info "Fetching ${S3_BASE}/latest.json…"
LATEST_JSON="$(curl -fsS --max-time 30 "${S3_BASE}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [[ -z "$VERSION" ]]; then
  log_error "Could not parse version from latest.json: ${LATEST_JSON}"
  exit 1
fi
log_info "Latest release: ${VERSION}"

INSTALLED_VERSION=""
[[ -f "$VERSION_FILE" ]] && INSTALLED_VERSION="$(cat "$VERSION_FILE")"

# ── Release record (controleReleases): the cm is a `shared` app of the project it is installed in ────────────────
# Written by mls-base's releaseRecord.mjs (the only writer of the record), on success and on failure. Missing node or
# script is only a warning: the install never fails because of the record.
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

RELEASE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
collab_record_shared() { # $1 = ok|falhou, $2 = failing step, $3 = message
  local rec=""
  rec="$(find_runtime_script "${COLLAB_RELEASE_RECORD_SCRIPT:-}" releaseRecord.mjs)" || rec=""
  if [[ -z "$rec" ]] || ! command -v node >/dev/null 2>&1; then
    log_warn "release record: releaseRecord.mjs or node not found; skipped"
    return 0
  fi
  node "$rec" shared --nome cm --antes "$INSTALLED_VERSION" --depois "$VERSION" --passos "download,install" \
    --inicio "$RELEASE_STARTED_AT" --resultado "$1" --falha "${2:-}" --mensagem "${3:-}" \
    || log_warn "release record not written"
  return 0
}

if [[ "$INSTALLED_VERSION" == "$VERSION" && "$FORCE" != true ]] && run_as_deploy pm2 describe msg &>/dev/null; then
  ensure_msg_configure_sdk
  log_ok "collab-messages ${VERSION} already installed and running (use --force to reinstall)"
  exit 0
fi

# The project the cm belongs to is kept outside the sources (/data/etc/shared.json, written once, never replaced by an
# update): COLLAB_RELEASE_PROJECT_ID, or the only project on the VM. With several projects and no variable it is left
# for `node scripts/runtime/sharedApps.mjs set-main --projeto <id>`.
collab_set_shared_main() {
  local tool="" project="${COLLAB_RELEASE_PROJECT_ID:-}" ids
  tool="$(find_runtime_script "${COLLAB_SHARED_APPS_SCRIPT:-}" sharedApps.mjs)" || tool=""
  if [[ -z "$tool" ]] || ! command -v node >/dev/null 2>&1; then
    log_warn "shared register: sharedApps.mjs or node not found; main project of the cm not recorded"
    return 0
  fi
  if [[ ! "$project" =~ ^[0-9]+$ ]]; then
    ids="$(ls "${COLLAB_ETC_DIR:-/data/etc}/projects" 2>/dev/null | sed -n 's/^\([0-9][0-9]*\)\.json$/\1/p' | sort -n)"
    if [[ "$(printf '%s\n' "$ids" | grep -c .)" -eq 1 ]]; then project="$ids"; else project=""; fi
  fi
  if [[ -z "$project" ]]; then
    log_info "shared register: no single project on this VM and no COLLAB_RELEASE_PROJECT_ID; set the cm main project with sharedApps.mjs set-main"
    return 0
  fi
  node "$tool" set-main --nome cm --projeto "$project" --if-absent --etc "${COLLAB_ETC_DIR:-/data/etc}" || log_warn "shared register not written"
  return 0
}

# From here a non-zero exit is a failed install: record it (the success path records and clears the trap).
trap 'rc=$?; trap - EXIT; if [[ $rc -ne 0 ]]; then collab_record_shared falhou install "install exited with status $rc"; fi; exit $rc' EXIT

# ── Download release ───────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR_MSG" "$NODE_DIR"
chown -R "${DEPLOY_USER}:" "$ROOT"

log_info "Downloading release ${VERSION}…"
curl -fsS --max-time 300 -o "$INSTALL_DIR_MSG/nodefiles.7z"      "${S3_BASE}/${VERSION}/nodefiles.7z"
curl -fsS --max-time 60  -o "$INSTALL_DIR_MSG/package.json"      "${S3_BASE}/${VERSION}/package.json"
curl -fsS --max-time 60  -o "$INSTALL_DIR_MSG/pnpm-workspace.yaml" "${S3_BASE}/${VERSION}/pnpm-workspace.yaml"
# pnpm-lock.yaml pins the dependency tree for every VM on this release. Releases
# published before the lock shipped return 404: tolerate it (addNewVersion falls
# back to installing without a lock) and drop any lock left by a previous
# release, so an old lock is never reused as if it were this release's.
if ! curl -fsS --max-time 60 -o "$INSTALL_DIR_MSG/pnpm-lock.yaml.download" "${S3_BASE}/${VERSION}/pnpm-lock.yaml"; then
  rm -f "$INSTALL_DIR_MSG/pnpm-lock.yaml.download" "$INSTALL_DIR_MSG/pnpm-lock.yaml"
  log_warn "release ${VERSION} has no pnpm-lock.yaml — installing without it (dependency tree may differ between VMs)"
else
  mv -f "$INSTALL_DIR_MSG/pnpm-lock.yaml.download" "$INSTALL_DIR_MSG/pnpm-lock.yaml"
fi
curl -fsS --max-time 60  -o "$ROOT/pm2.config.js"                "${S3_BASE}/${VERSION}/pm2.config.js"
curl -fsS --max-time 60  -o "$ROOT/addNewVersion"                "${S3_BASE}/${VERSION}/addNewVersion"
chmod +x "$ROOT/addNewVersion"
log_ok "Release files downloaded"

# ── Basic appconfig.json (real credentials configured later) ────────────────────
if [[ -f "$NODE_DIR/appconfig.json" ]]; then
  log_info "appconfig.json already present — leaving it untouched"
else
  log_info "Creating basic ${NODE_DIR}/appconfig.json (fill in credentials later)…"
  cat > "$NODE_DIR/appconfig.json" <<'EOF'
{
  "hook": { "collabtoken": "" },
  "redis": { "host": "127.0.0.1", "port": 6379 },
  "aws": { "accessKeyId": "", "secretAccessKey": "", "bucketName": "" },
  "storage": { "dynamoRegion": "", "s3Region": "", "bucket": "" },
  "notificationLog": { "enabled": false, "keepDays": 7 }
}
EOF
  chmod 600 "$NODE_DIR/appconfig.json"
  chown "${DEPLOY_USER}:" "$NODE_DIR/appconfig.json"
  log_ok "appconfig.json created"
fi
chown -R "${DEPLOY_USER}:" "$ROOT"
if [[ -f "$NODE_DIR/appconfig.json" ]]; then
  chmod 600 "$NODE_DIR/appconfig.json"
  chown "${DEPLOY_USER}:" "$NODE_DIR/appconfig.json"
fi

# ── Install release (release layout + pm2 startOrReload) ────────────────────────
PNPM_RESOLVED="$(command -v pnpm || true)"
if [[ -z "$PNPM_RESOLVED" ]]; then
  log_error "pnpm not found — run step 10 (mls-base runtime) first"
  exit 1
fi
log_info "Running addNewVersion --updatePackage as ${DEPLOY_USER}…"
run_as_deploy env PNPM_BIN="$PNPM_RESOLVED" COLLAB_MESSAGES_DEPLOY_ROOT="$ROOT" COLLAB_WEBPUSH_SOURCE=parameter-store "$ROOT/addNewVersion" --updatePackage
echo "$VERSION" > "$VERSION_FILE"
chown "${DEPLOY_USER}:" "$VERSION_FILE"
chown -R "${DEPLOY_USER}:" "$ROOT"
if [[ -f "$NODE_DIR/appconfig.json" ]]; then
  chmod 600 "$NODE_DIR/appconfig.json"
  chown "${DEPLOY_USER}:" "$NODE_DIR/appconfig.json"
fi
ensure_msg_configure_sdk
log_ok "collab-messages ${VERSION} installed (pm2 app: msg, user: ${DEPLOY_USER})"
collab_record_shared ok
trap - EXIT
collab_set_shared_main

# ── nginx: expose /msg → 127.0.0.1:8180 ────────────────────────────────────────
SNIPPET="/etc/nginx/snippets/collab-messages.conf"
DEFAULT_SITE="/etc/nginx/sites-available/default"
if command -v nginx &>/dev/null; then
  mkdir -p /etc/nginx/snippets
  cat > "$SNIPPET" <<'EOF'
# collab-messages backend (pm2 app 'msg') — managed by collab-runtime step 11
location /msg {
    proxy_pass http://127.0.0.1:8180;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # streaming responses (SSE)
    proxy_buffering off;
    proxy_read_timeout 300s;
}
EOF
  if [[ -f "$DEFAULT_SITE" ]] && ! grep -q "snippets/collab-messages.conf" "$DEFAULT_SITE"; then
    # Inject the include into the default server block (custom server blocks
    # can include the same snippet).
    sed -i '0,/server_name _;/s//server_name _;\n\n\tinclude snippets\/collab-messages.conf;/' "$DEFAULT_SITE"
  fi
  if nginx -t &>/dev/null; then
    systemctl reload nginx || log_warn "nginx reload failed (continuing)"
    log_ok "nginx: /msg proxied to 127.0.0.1:8180"
  else
    log_warn "nginx config test failed — /msg proxy not activated (check ${SNIPPET})"
  fi
else
  log_warn "nginx not found — skipping /msg proxy (run step 02 first)"
fi

# ── Make this script available to the collab CLI ('collab msg update') ─────────
mkdir -p "$CLI_LIB_DIR"
if [[ "$SCRIPT_DIR" != "$CLI_LIB_DIR" ]]; then
  cp "${BASH_SOURCE[0]}" "$CLI_LIB_DIR/install-collab-messages.sh"
  chmod +x "$CLI_LIB_DIR/install-collab-messages.sh"
  if [[ -f "${REPO_ROOT}/core/utils.sh" ]]; then
    cp "${REPO_ROOT}/core/utils.sh" "$CLI_LIB_DIR/utils.sh"
  fi
fi

log_ok "collab-messages ready — check with: sudo -u ${DEPLOY_USER} -H pm2 ls | grep msg"
