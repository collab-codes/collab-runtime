import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const utils = join(root, "core/utils.sh");
const step08 = readFileSync(join(root, "scripts/08-install-pm2.sh"), "utf8");
const step10 = readFileSync(join(root, "scripts/10-mls-runtime.sh"), "utf8");
const step11 = readFileSync(join(root, "scripts/11-install-collab-messages.sh"), "utf8");
const step12 = readFileSync(join(root, "scripts/12-mls-project.sh"), "utf8");
const cli = readFileSync(join(root, "collab"), "utf8");

function bash(script) {
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
}

test("08 registers pm2 startup for DEPLOY_USER, not the installer USER/HOME", () => {
  assert.match(step08, /resolve_deploy_user/);
  assert.match(step08, /pm2 startup systemd -u "\$DEPLOY_USER" --hp "\$DEPLOY_HOME"/);
  assert.doesNotMatch(step08, /pm2 startup systemd -u "\$USER" --hp "\$HOME"/);
});

test("08 fails the step when more than one pm2 systemd unit exists", () => {
  assert.match(step08, /assert_one_pm2_unit/);
  assert.match(step08, /expected exactly one pm2 systemd unit/);
});

test("08 migrates pm2-root to the deploy user before dropping the old unit", () => {
  assert.match(step08, /migrate_pm2_root_if_needed/);
  assert.match(step08, /pm2-root\.service/);
  assert.match(step08, /wait_pm2_app_online/);
  assert.match(step08, /Restoring the root daemon from its dump/);
  const waitAt = step08.indexOf("wait_pm2_app_online");
  const deleteAt = step08.indexOf("pm2 delete all");
  assert.ok(waitAt > 0 && deleteAt > waitAt, "old apps are deleted only after the new daemon is online");
  assert.match(step08, /chmod 600 \/data\/msg\.collab\.codes\/node\/appconfig\.json/);
});

test("11 runs addNewVersion as the deploy user and keeps appconfig at 600", () => {
  assert.match(step11, /resolve_deploy_user/);
  assert.match(step11, /run_as_deploy env PNPM_BIN=.*addNewVersion" --updatePackage/);
  assert.match(step11, /chmod 600 "\$NODE_DIR\/appconfig\.json"/);
  assert.doesNotMatch(step11, /chmod 644/);
  assert.match(step11, /run_as_deploy pm2 describe msg/);
  assert.match(step11, /chown "\$\{DEPLOY_USER\}:" "\$NODE_DIR\/appconfig\.json"/);
});

test("10 and 12 use resolve_deploy_user instead of SUDO_USER:-root", () => {
  assert.match(step10, /resolve_deploy_user/);
  assert.match(step12, /resolve_deploy_user/);
  assert.doesNotMatch(step10, /DEPLOY_USER="\$\{SUDO_USER:-root\}"/);
  assert.doesNotMatch(step12, /DEPLOY_USER="\$\{SUDO_USER:-root\}"/);
});

test("collab msg status talks to the deploy user's pm2", () => {
  assert.match(cli, /run_as_deploy pm2 ls/);
  assert.match(cli, /multiple pm2 systemd units/);
});

test("resolve_deploy_user prefers the non-root owner of COLLAB_DATA_ROOT", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm37-data-"));
  const me = userInfo().username;
  const out = bash(`
    set -euo pipefail
    COLLAB_DATA_ROOT=${JSON.stringify(dir)}
    SUDO_USER=root
    unset COLLAB_DEPLOY_USER || true
    source ${JSON.stringify(utils)}
    resolve_deploy_user
    printf '%s' "\$DEPLOY_USER"
  `);
  assert.equal(out, me);
});

test("resolve_deploy_user honors COLLAB_DEPLOY_USER over /data owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm37-data-"));
  const me = userInfo().username;
  const out = bash(`
    set -euo pipefail
    COLLAB_DATA_ROOT=${JSON.stringify(dir)}
    COLLAB_DEPLOY_USER=${JSON.stringify(me)}
    SUDO_USER=root
    source ${JSON.stringify(utils)}
    resolve_deploy_user
    printf '%s' "\$DEPLOY_USER"
  `);
  assert.equal(out, me);
});

test("resolve_deploy_user falls back to non-root SUDO_USER when /data is missing", () => {
  const me = userInfo().username;
  const out = bash(`
    set -euo pipefail
    COLLAB_DATA_ROOT=/no-such-collab-data-root-cm37
    SUDO_USER=${JSON.stringify(me)}
    unset COLLAB_DEPLOY_USER || true
    source ${JSON.stringify(utils)}
    resolve_deploy_user
    printf '%s' "\$DEPLOY_USER"
  `);
  assert.equal(out, me);
});
