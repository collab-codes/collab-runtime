import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

test("08 writes a systemd drop-in so pm2 waits for the configured data root", () => {
  assert.match(step08, /write_pm2_data_mount_dropin/);
  assert.match(step08, /unit="pm2-\$\{DEPLOY_USER\}\.service"/);
  assert.match(step08, /dropin_dir="\/etc\/systemd\/system\/\$\{unit\}\.d"/);
  assert.match(step08, /data-mount\.conf/);
  assert.match(step08, /RequiresMountsFor=\$\{COLLAB_DATA_ROOT\}/);
  assert.match(step08, /mv -f "\$tmp" "\$\{dropin_dir\}\/data-mount\.conf"/);
  assert.doesNotMatch(step08, /RequiresMountsFor=\/data/);
  const startupAt = step08.indexOf('pm2 startup systemd -u "$DEPLOY_USER" --hp "$DEPLOY_HOME"');
  const dropinAt = step08.indexOf("write_pm2_data_mount_dropin");
  const callAt = step08.lastIndexOf("apply_pm2_fixed_startup");
  assert.ok(startupAt > 0 && dropinAt > 0 && callAt > startupAt, "drop-in is written after pm2 startup so a unit rewrite cannot drop it");
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

test("11 installs AWS SDK for msg-configure even when msg is already installed, never AWS CLI", () => {
  assert.match(step11, /ensure_msg_configure_sdk\(\)/);
  assert.match(step11, /@aws-sdk\/client-sts@\^3\.1127\.0/);
  assert.match(step11, /@aws-sdk\/client-ssm@\^3\.744\.0/);
  assert.match(step11, /no AWS CLI/);
  assert.doesNotMatch(step11, /aws-cli|awscli|amazon-linux-extras.*aws/);
  const early = step11.slice(
    step11.indexOf('INSTALLED_VERSION" == "$VERSION"'),
    step11.indexOf("Download release"),
  );
  assert.match(early, /ensure_msg_configure_sdk/);
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

const step08Path = join(root, "scripts/08-install-pm2.sh");

function writeStub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function stepEnv(dir, extra = {}) {
  const bin = join(dir, "bin");
  const etc = join(dir, "etc");
  const lib = join(dir, "lib");
  const collabLib = join(dir, "collab-lib");
  const logs = join(dir, "logs");
  const calls = join(dir, "calls.log");
  for (const path of [bin, etc, lib, collabLib, logs]) mkdirSync(path, { recursive: true });
  writeFileSync(calls, "");
  const record = `printf '%s\\n' "$0 $*" >> ${JSON.stringify(calls)}`;
  writeStub(bin, "pm2", `#!/bin/bash\n${record}\nexit 99\n`);
  writeStub(bin, "npm", `#!/bin/bash\n${record}\nexit 99\n`);
  writeStub(bin, "pm2-real", `#!/bin/bash\n${record}\nexit 99\n`);
  writeStub(
    bin,
    "systemctl",
    `#!/bin/bash
${record}
if [[ "$1" == "daemon-reload" && "\${RT112_FAIL_SYSTEMCTL:-}" == "1" ]]; then
  echo "systemctl daemon-reload failed" >&2
  exit 1
fi
if [[ "$1" != "daemon-reload" ]]; then
  echo "unexpected systemctl $*" >&2
  exit 1
fi
exit 0
`,
  );
  writeStub(
    bin,
    "systemd-analyze",
    `#!/bin/bash
${record}
if [[ "$1" != "verify" ]]; then
  echo "unexpected systemd-analyze $*" >&2
  exit 1
fi
exit 0
`,
  );
  const me = userInfo();
  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LOG_DIR: logs,
      COLLAB_SYSTEMD_ETC: etc,
      COLLAB_SYSTEMD_LIB: lib,
      COLLAB_LIB_DIR: collabLib,
      COLLAB_DATA_ROOT: extra.dataRoot ?? join(dir, "data"),
      COLLAB_DEPLOY_USER: me.username,
      RT112_FAIL_SYSTEMCTL: extra.failSystemctl ? "1" : "",
    },
    etc,
    collabLib,
    calls,
    pm2Bin: join(bin, "pm2-real"),
    home: me.homedir,
    user: me.username,
  };
}

function writeUnit(ctx) {
  writeFileSync(
    join(ctx.etc, `pm2-${ctx.user}.service`),
    `[Service]
Type=forking
User=${ctx.user}
Environment=PM2_HOME=${ctx.home}/.pm2
PIDFile=${ctx.home}/.pm2/pm2.pid
ExecStart=${ctx.pm2Bin} resurrect
ExecReload=${ctx.pm2Bin} reload all
ExecStop=${ctx.pm2Bin} kill
`,
  );
}

function runStep(ctx, args) {
  return execFileSync("bash", [step08Path, ...args], {
    encoding: "utf8",
    env: ctx.env,
    timeout: 20000,
  });
}

function failStep(ctx, args) {
  try {
    runStep(ctx, args);
  } catch (error) {
    return error;
  }
  throw new Error("expected step 08 to fail");
}

test("--startup-only writes one ExecStart, timeout 900, custom data root, and keeps the mount drop-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt112-s2-"));
  const dataRoot = join(dir, "custom data");
  const ctx = stepEnv(dir, { dataRoot });
  writeUnit(ctx);
  const dropin = join(ctx.etc, `pm2-${ctx.user}.service.d`);
  mkdirSync(dropin, { recursive: true });
  writeFileSync(join(dropin, "keep-me.conf"), "LeaveThis\n");
  runStep(ctx, ["--startup-only"]);
  const first = readFileSync(join(dropin, "fixed-configs.conf"), "utf8");
  runStep(ctx, ["--startup-only"]);
  const fixed = readFileSync(join(dropin, "fixed-configs.conf"), "utf8");
  assert.equal(fixed, first);
  const mount = readFileSync(join(dropin, "data-mount.conf"), "utf8");
  const helper = join(ctx.collabLib, "pm2-start-fixed.sh");
  const apps = `${dataRoot}/mls-base/pm2.config.js`;
  const messages = `${dataRoot}/msg.collab.codes/pm2.config.js`;
  const execLines = fixed.split("\n").filter((line) => line.startsWith("ExecStart="));
  assert.deepEqual(execLines, [
    "ExecStart=",
    `ExecStart="${helper}" "${ctx.pm2Bin}" "${apps}" "${messages}"`,
  ]);
  assert.equal(fixed.match(/TimeoutStopSec=900s/g)?.length, 1);
  assert.doesNotMatch(fixed, /Type=|PIDFile=|ExecStop=|ExecReload=|oneshot/);
  const escapedRoot = dataRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(mount, new RegExp(`^\\[Unit\\]\\nRequiresMountsFor=${escapedRoot}\\n$`));
  assert.equal(readFileSync(join(dropin, "keep-me.conf"), "utf8"), "LeaveThis\n");
  assert.equal(statSync(helper).mode & 0o777, 0o755);
  const calls = readFileSync(ctx.calls, "utf8");
  assert.match(calls, /systemctl daemon-reload/);
  assert.match(calls, /systemd-analyze verify/);
  assert.doesNotMatch(calls, /\/(pm2|npm|pm2-real) /);
  const unit = readFileSync(join(ctx.etc, `pm2-${ctx.user}.service`), "utf8");
  assert.match(unit, /ExecStop=/);
  assert.match(unit, /ExecStart=.*resurrect/);
});

test("--startup-only fails when the deploy unit is missing and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt112-s2-missing-"));
  const ctx = stepEnv(dir);
  const error = failStep(ctx, ["--startup-only"]);
  assert.notEqual(error.status, 0);
  assert.match(error.stderr ?? "", /unit for .* is missing/);
  assert.equal(readFileSync(ctx.calls, "utf8"), "");
});

test("--startup-only reports systemctl failure and does not log success", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt112-s2-systemctl-"));
  const ctx = stepEnv(dir, { failSystemctl: true });
  writeUnit(ctx);
  const error = failStep(ctx, ["--startup-only"]);
  assert.notEqual(error.status, 0);
  assert.match(error.stderr ?? "", /daemon-reload failed/);
  assert.doesNotMatch(`${error.stdout ?? ""}`, /\[ OK \]/);
  const calls = readFileSync(ctx.calls, "utf8");
  assert.doesNotMatch(calls, /systemd-analyze/);
  assert.doesNotMatch(calls, /\/(pm2|npm|pm2-real) /);
});

test("08 rejects an unknown flag before writing drop-ins", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt112-s2-flag-"));
  const ctx = stepEnv(dir);
  const error = failStep(ctx, ["--resurrect"]);
  assert.equal(error.status, 64);
  assert.match(error.stderr ?? "", /unknown argument/);
  assert.equal(readFileSync(ctx.calls, "utf8"), "");
});

function writeStubBody(dir, name, body) {
  writeStub(dir, name, body);
}

function extractBashFunction(source, name) {
  const marker = `${name}() {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, name);
  let depth = 0;
  let quote = "";
  for (let i = start + marker.length - 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

test("normal install starts up the deploy user, keeps logrotate, and does not boot from resurrect", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt112-s3-normal-"));
  const ctx = stepEnv(dir);
  const bin = join(dir, "bin");
  writeStubBody(
    bin,
    "timeout",
    `#!/bin/bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    --*) shift ;;
    *[!0-9]*) break ;;
    *) shift; break ;;
  esac
done
exec "$@"
`,
  );
  writeStubBody(
    bin,
    "pm2",
    `#!/bin/bash
printf '%s\\n' "$0 $*" >> ${JSON.stringify(ctx.calls)}
if [[ "$1" == "--version" ]]; then
  echo 0.test
  exit 0
fi
if [[ "$1" == "startup" ]]; then
  user=""
  home=""
  args=("$@")
  for ((i = 0; i < \${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "-u" ]]; then user="\${args[$((i + 1))]}"; fi
    if [[ "\${args[$i]}" == "--hp" ]]; then home="\${args[$((i + 1))]}"; fi
  done
  cat > "\${COLLAB_SYSTEMD_ETC}/pm2-\${user}.service" <<EOF
[Service]
Type=forking
User=\${user}
Environment=PM2_HOME=\${home}/.pm2
PIDFile=\${home}/.pm2/pm2.pid
ExecStart=${ctx.pm2Bin} resurrect
ExecReload=${ctx.pm2Bin} reload all
ExecStop=${ctx.pm2Bin} kill
EOF
fi
exit 0
`,
  );
  let error = null;
  try {
    runStep(ctx, []);
  } catch (caught) {
    error = caught;
  }
  const calls = readFileSync(ctx.calls, "utf8");
  assert.match(calls, new RegExp(`pm2 startup systemd -u ${ctx.user} --hp ${ctx.home}`));
  assert.match(calls, /pm2 install pm2-logrotate/);
  assert.match(calls, /pm2 set pm2-logrotate:max_size 100M/);
  assert.match(calls, /pm2 save/);
  assert.doesNotMatch(calls, /resurrect/);
  assert.doesNotMatch(calls, /\bnpm\b/);
  const unitPath = join(ctx.etc, `pm2-${ctx.user}.service`);
  const unit = readFileSync(unitPath, "utf8");
  assert.match(unit, new RegExp(`^User=${ctx.user}$`, "m"));
  assert.match(unit, /ExecStart=.*resurrect/);
  const fixed = readFileSync(join(ctx.etc, `pm2-${ctx.user}.service.d`, "fixed-configs.conf"), "utf8");
  const execLines = fixed.split("\n").filter((line) => line.startsWith("ExecStart="));
  assert.equal(execLines[0], "ExecStart=");
  assert.match(execLines[1], /pm2-start-fixed\.sh/);
  assert.doesNotMatch(fixed, /resurrect/);
  // assert_one_pm2_unit scans the host with GNU find -printf. On macOS that
  // command exits 1 after logrotate, with no unit-count line. A Linux host
  // reports the real unit count instead. Either way the calls above already ran.
  if (error) {
    const stderr = `${error.stderr ?? ""}`;
    assert.ok(
      stderr === "" || /expected exactly one pm2 systemd unit/.test(stderr),
      stderr,
    );
  }
});

function migrateHarness(dir, { online }) {
  const bin = join(dir, "bin");
  const etc = join(dir, "etc", "systemd", "system");
  const lib = join(dir, "lib", "systemd", "system");
  const rootPm2 = join(dir, "root-pm2");
  const home = join(dir, "home");
  const msg = join(dir, "msg");
  const calls = join(dir, "calls.log");
  const logs = join(dir, "logs");
  for (const path of [bin, etc, lib, rootPm2, home, join(msg, "node"), logs]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(calls, "");
  writeFileSync(join(etc, "pm2-root.service"), "[Service]\nExecStart=/usr/bin/pm2 resurrect\n");
  writeFileSync(join(rootPm2, "dump.pm2"), "dump-fixture\n");
  writeFileSync(join(msg, "node", "appconfig.json"), "{}\n");
  const me = userInfo().username;
  writeStub(
    bin,
    "sudo",
    `#!/bin/bash
if [[ "$1" == "-u" ]]; then
  shift 2
  if [[ "$1" == "-H" ]]; then shift; fi
  exec "$@"
fi
exit 1
`,
  );
  writeStub(
    bin,
    "systemctl",
    `#!/bin/bash
printf '%s\\n' "systemctl $*" >> ${JSON.stringify(calls)}
exit 0
`,
  );
  writeStub(
    bin,
    "pm2",
    `#!/bin/bash
printf '%s\\n' "pm2 $*" >> ${JSON.stringify(calls)}
if [[ "$1" == "jlist" ]]; then
  printf '%s\\n' '[{"name":"msg"},{"name":"pm2-logrotate"}]'
  exit 0
fi
if [[ "$1" == "describe" && "${online ? "1" : ""}" == "1" ]]; then
  echo "status online"
fi
exit 0
`,
  );
  const migrated = extractBashFunction(step08, "migrate_pm2_root_if_needed")
    .replaceAll("/etc/systemd/system", etc)
    .replaceAll("/lib/systemd/system", lib)
    .replaceAll("/root/.pm2", rootPm2)
    .replaceAll("/data/msg.collab.codes", msg);
  const script = `#!/bin/bash
set -euo pipefail
export PATH=${JSON.stringify(bin)}:$PATH
export LOG_DIR=${JSON.stringify(logs)}
export DEPLOY_USER=${JSON.stringify(me)}
export DEPLOY_HOME=${JSON.stringify(home)}
source ${JSON.stringify(join(root, "core/utils.sh"))}
source ${JSON.stringify(join(root, "core/logger.sh"))}
${extractBashFunction(step08, "pm2_app_names_from_jlist")}
${extractBashFunction(step08, "pm2_root_app_names")}
${extractBashFunction(step08, "wait_pm2_app_online")}
${migrated}
migrate_pm2_root_if_needed
`;
  const scriptPath = join(dir, "migrate.sh");
  writeFileSync(scriptPath, script);
  return { scriptPath, calls, etc, home, msg, rootPm2, user: me };
}

test("root migration still resurrects onto the deploy user and rolls back without becoming boot", () => {
  const onlineDir = mkdtempSync(join(tmpdir(), "rt112-s3-migrate-"));
  const online = migrateHarness(onlineDir, { online: true });
  execFileSync("bash", [online.scriptPath], { encoding: "utf8", timeout: 20000 });
  const onlineCalls = readFileSync(online.calls, "utf8");
  assert.match(onlineCalls, /pm2 save\n[\s\S]*pm2 stop all\n[\s\S]*pm2 resurrect\n/);
  assert.match(onlineCalls, /pm2 delete all/);
  assert.doesNotMatch(onlineCalls, /pm2-start-fixed/);
  assert.equal(readFileSync(join(online.home, ".pm2", "dump.pm2"), "utf8"), "dump-fixture\n");
  assert.equal(statSync(join(online.msg, "node", "appconfig.json")).mode & 0o777, 0o600);
  assert.throws(() => statSync(join(online.etc, "pm2-root.service")));

  const rollbackDir = mkdtempSync(join(tmpdir(), "rt112-s3-rollback-"));
  const rollback = migrateHarness(rollbackDir, { online: false });
  let error = null;
  try {
    execFileSync("bash", [rollback.scriptPath], { encoding: "utf8", timeout: 45000 });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.notEqual(error.status, 0);
  assert.match(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, /Restoring the root daemon from its dump/);
  assert.match(readFileSync(rollback.calls, "utf8"), /pm2 resurrect[\s\S]*pm2 resurrect/);
  assert.equal(readFileSync(join(rollback.etc, "pm2-root.service"), "utf8").includes("resurrect"), true);
  assert.doesNotMatch(readFileSync(rollback.calls, "utf8"), /pm2-start-fixed/);
});
