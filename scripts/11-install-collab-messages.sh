#!/bin/bash
# scripts/11-install-collab-messages.sh
# Install or update collab-messages (the 'msg' pm2 app) from the public S3
# release published by collab-messages/publishCollabMessages.sh:
#   - downloads the latest release (nodefiles.7z, package.json, pm2.config.js,
#     addNewVersion) from s3://www.collab.codes/collab-messages/ (public,
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

# Self-contained logging: source core helpers when running from the repo
# checkout, fall back to plain echo when running from /usr/local/lib/collab.
if [[ -f "${REPO_ROOT}/core/logger.sh" ]]; then
  source "${REPO_ROOT}/core/logger.sh"
  source "${REPO_ROOT}/core/utils.sh"
else
  log_section() { echo ""; echo "=== $* ==="; }
  log_info()    { echo "[INFO] $*"; }
  log_ok()      { echo "[OK]   $*"; }
  log_warn()    { echo "[WARN] $*"; }
  log_error()   { echo "[ERR]  $*" >&2; }
fi

log_section "Step 11 — collab-messages (msg)"

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

if [[ "$INSTALLED_VERSION" == "$VERSION" && "$FORCE" != true ]] && pm2 describe msg &>/dev/null; then
  log_ok "collab-messages ${VERSION} already installed and running (use --force to reinstall)"
  exit 0
fi

# ── Download release ───────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR_MSG" "$NODE_DIR"

log_info "Downloading release ${VERSION}…"
curl -fsS --max-time 300 -o "$INSTALL_DIR_MSG/nodefiles.7z"      "${S3_BASE}/${VERSION}/nodefiles.7z"
curl -fsS --max-time 60  -o "$INSTALL_DIR_MSG/package.json"      "${S3_BASE}/${VERSION}/package.json"
curl -fsS --max-time 60  -o "$INSTALL_DIR_MSG/pnpm-workspace.yaml" "${S3_BASE}/${VERSION}/pnpm-workspace.yaml"
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
  "llm": {
    "openai": "",
    "google": "",
    "openrouter": "",
    "azure": "",
    "anthropic": "",
    "grok": "",
    "deepseek": "",
    "collab": ""
  },
  "hook": {
    "collabtoken": ""
  },
  "redis": {
    "host": "127.0.0.1",
    "port": 6379
  },
  "langchain": {
    "langsmith": ""
  },
  "aws": {
    "accessKeyId": "",
    "secretAccessKey": "",
    "bucketName": ""
  },
  "firebase": {
    "apiKey": "",
    "authDomain": "",
    "projectId": "",
    "storageBucket": "",
    "messagingSenderId": "",
    "appId": ""
  },
  "firebaseBackEnd": {
    "project_id": "",
    "client_email": "",
    "private_key": ""
  }
}
EOF
  chmod 600 "$NODE_DIR/appconfig.json"
  log_ok "appconfig.json created"
fi

# ── Install release (release layout + pm2 startOrReload) ────────────────────────
PNPM_RESOLVED="$(command -v pnpm || true)"
if [[ -z "$PNPM_RESOLVED" ]]; then
  log_error "pnpm not found — run step 10 (mls-base runtime) first"
  exit 1
fi
log_info "Running addNewVersion --updatePackage…"
PNPM_BIN="$PNPM_RESOLVED" COLLAB_MESSAGES_DEPLOY_ROOT="$ROOT" "$ROOT/addNewVersion" --updatePackage
echo "$VERSION" > "$VERSION_FILE"
log_ok "collab-messages ${VERSION} installed (pm2 app: msg)"

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
fi

log_ok "collab-messages ready — check with: pm2 ls | grep msg"
