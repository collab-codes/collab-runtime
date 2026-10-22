import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { guardPm2, withLifecycleLock } from "./pm2-lifecycle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "scripts/pm2-start-fixed.sh");

const appsFixture = `module.exports = { apps: [
  { name: "app2047", instances: 2, exec_mode: "cluster" }
] };
`;

const messagesFixture = `const apps = [
  { name: "msg", instances: 2, exec_mode: "cluster" }
];
if (process.env.COLLAB_MESSAGES_ENABLE_WORKER !== "false") {
  apps.push({ name: "msg-worker", instances: 1, exec_mode: "fork" });
}
module.exports = { apps };
`;

function writePm2Stub(dir) {
  const stubPath = join(dir, "pm2");
  const logPath = join(dir, "calls.log");
  writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const logPath = process.env.PM2_STUB_LOG;
const args = process.argv.slice(2);
const sleepMs = Number(process.env.PM2_STUB_SLEEP_MS || "0");
if (sleepMs > 0) {
  const end = Date.now() + sleepMs;
  while (Date.now() < end) {}
}
const forbidden = args.some((arg) => /resurrect|dump|save|startup/u.test(arg));
if (forbidden) {
  appendFileSync(logPath, JSON.stringify({ cmd: args, forbidden: true }) + "\\n");
  process.exit(99);
}
if (args.length === 1 && args[0] === "ping") {
  appendFileSync(logPath, JSON.stringify({ cmd: args }) + "\\n");
  const home = process.env.PM2_HOME;
  const pid = process.env.PM2_STUB_PID || "4242";
  if (home && process.env.PM2_STUB_SKIP_PID !== "1") {
    writeFileSync(home + "/pm2.pid", pid + "\\n");
  }
  process.exit(0);
}
if (!(args.length === 3 && args[0] === "start" && args[2] === "--update-env")) {
  appendFileSync(logPath, JSON.stringify({ cmd: args, unexpected: true }) + "\\n");
  process.exit(97);
}
const configPath = args[1];
let text = "";
try {
  text = readFileSync(configPath, "utf8");
} catch (error) {
  appendFileSync(logPath, JSON.stringify({ cmd: args, readError: String(error) }) + "\\n");
  process.exit(4);
}
if (text.includes("INVALID_PM2_CONFIG")) {
  appendFileSync(logPath, JSON.stringify({ cmd: args, invalid: true }) + "\\n");
  process.exit(4);
}
let apps = [];
try {
  const loaded = createRequire(configPath)(configPath);
  apps = (loaded.apps || []).map((app) => ({
    name: app.name,
    instances: app.instances,
    exec_mode: app.exec_mode,
  }));
} catch (error) {
  appendFileSync(logPath, JSON.stringify({ cmd: args, evalError: String(error) }) + "\\n");
  process.exit(4);
}
appendFileSync(logPath, JSON.stringify({
  cmd: args,
  workerFlag: Object.prototype.hasOwnProperty.call(process.env, "COLLAB_MESSAGES_ENABLE_WORKER")
    ? process.env.COLLAB_MESSAGES_ENABLE_WORKER
    : null,
  apps,
}) + "\\n");
const home = process.env.PM2_HOME;
const pid = process.env.PM2_STUB_PID || "4242";
if (home && process.env.PM2_STUB_SKIP_PID !== "1") {
  writeFileSync(home + "/pm2.pid", pid + "\\n");
}
`);
  chmodSync(stubPath, 0o755);
  writeFileSync(logPath, "");
  return { stubPath, logPath };
}

function callsOf(logPath) {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const flockShim = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
const args = process.argv.slice(2);
let i = 0;
let wait = 0;
if (args[i] === "-w") {
  wait = Number(args[i + 1]);
  i += 2;
}
if (args[i] === "--") i += 1;
const file = args[i];
i += 1;
const cmd = args.slice(i);
if (!file || cmd.length === 0 || !Number.isFinite(wait)) process.exit(2);
const hold = file + ".hold";
const start = Date.now();
for (;;) {
  try {
    mkdirSync(hold);
    break;
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    if (Date.now() - start >= wait * 1000) process.exit(1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
let status = 1;
try {
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env });
  status = result.status === null ? 1 : result.status;
} finally {
  rmSync(hold, { recursive: true, force: true });
}
process.exit(status);
`;

const lifecycleStub = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = process.env.PM2_LIFECYCLE_LOG || "";
const cmd = process.argv[2];
const mark = (event) => {
  if (log) appendFileSync(log, JSON.stringify({ event, t: Date.now() }) + "\\n");
};
if (cmd === "validate-home") process.exit(0);
if (cmd === "guard") {
  mark("guard-begin");
  const sleepMs = Number(process.env.PM2_GUARD_SLEEP_MS || "0");
  if (sleepMs > 0) {
    const end = Date.now() + sleepMs;
    while (Date.now() < end) {}
  }
  mark("guard-end");
  process.exit(Number(process.env.PM2_GUARD_CODE || "0"));
}
process.exit(64);
`;

function writeProc(dir, { inUnit = true, daemonService = "collab-pm2.service", daemonPid = "4242", bootId = "boot-test" } = {}) {
  const proc = join(dir, "proc");
  const selfCgroup = inUnit
    ? "0::/system.slice/collab-pm2.service\n"
    : "0::/user.slice/session-1.scope\n";
  mkdirSync(join(proc, "self"), { recursive: true });
  mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
  mkdirSync(join(proc, daemonPid), { recursive: true });
  writeFileSync(join(proc, "self/cgroup"), selfCgroup);
  writeFileSync(join(proc, "sys/kernel/random/boot_id"), `${bootId}\n`);
  writeFileSync(join(proc, daemonPid, "cgroup"), `0::/system.slice/${daemonService}\n`);
  return proc;
}

function stage(dir, { helperPresent = true, helperMode = 0o644, inUnit = true, daemonService = "collab-pm2.service" } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = join(dir, "pm2-start-fixed.sh");
  copyFileSync(helper, script);
  chmodSync(script, 0o755);
  if (helperPresent) {
    const life = join(dir, "pm2-lifecycle.mjs");
    writeFileSync(life, lifecycleStub);
    chmodSync(life, helperMode);
  }
  const flockPath = join(bin, "flock");
  writeFileSync(flockPath, flockShim);
  chmodSync(flockPath, 0o755);
  const home = join(dir, "pm2home");
  mkdirSync(home);
  const proc = writeProc(dir, { inUnit, daemonService });
  return { script, bin, home, proc, lifeLog: join(dir, "lifecycle.log") };
}

function baseEnv(staged, extra) {
  return {
    PATH: `${staged.bin}:${process.env.PATH}`,
    PM2_HOME: staged.home,
    COLLAB_PROC: staged.proc,
    PM2_LIFECYCLE_LOG: staged.lifeLog,
    PM2_GUARD_CODE: "0",
    ...extra,
  };
}

function invoke(script, args, env) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function invokeAsync(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("starts apps then messages and keeps the worker when the external flag is false", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "path with spaces", "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "path with spaces", "msg.collab.codes", "pm2.config.js");
  const dumpPath = join(dir, "dump.pm2");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);
  writeFileSync(dumpPath, "SECRET_DUMP resurrect app-from-dump\n");

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
    NODE_ENV: "production",
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes("SECRET_DUMP"), false);
  for (const phase of ["validate-home", "lock", "guard", "apps", "messages", "done"]) {
    assert.match(result.stderr, new RegExp(`bootId=boot-test phase=${phase} edge=begin mono=\\d+`));
    assert.match(result.stderr, new RegExp(`bootId=boot-test phase=${phase} edge=end mono=\\d+ durationMs=\\d+ code=0`));
  }
  const calls = callsOf(logPath);
  assert.deepEqual(calls.map((call) => call.cmd), [
    ["start", appsConfig, "--update-env"],
    ["start", messagesConfig, "--update-env"],
  ]);
  assert.equal(calls[0].workerFlag, "false");
  assert.equal(calls[1].workerFlag, null);
  assert.deepEqual(calls[0].apps, [{ name: "app2047", instances: 2, exec_mode: "cluster" }]);
  assert.deepEqual(calls[1].apps, [
    { name: "msg", instances: 2, exec_mode: "cluster" },
    { name: "msg-worker", instances: 1, exec_mode: "fork" },
  ]);
  assert.equal(readFileSync(dumpPath, "utf8"), "SECRET_DUMP resurrect app-from-dump\n");
  assert.equal(result.stdout.includes("SECRET_DUMP"), false);
  assert.equal(result.stderr.includes("SECRET_DUMP"), false);
});

test("apps only diagnoses the missing messages path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`config absent: ${messagesConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const calls = callsOf(logPath);
  assert.deepEqual(calls.map((call) => call.cmd), [["start", appsConfig, "--update-env"]]);
  assert.equal(calls[0].apps[0].instances, 2);
});

test("messages only still loads msg-worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "no apps", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(messagesConfig, messagesFixture);

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /config absent:/u);
  const calls = callsOf(logPath);
  assert.deepEqual(calls.map((call) => call.cmd), [["start", messagesConfig, "--update-env"]]);
  assert.equal(calls[0].workerFlag, null);
  assert.deepEqual(calls[0].apps, [
    { name: "msg", instances: 2, exec_mode: "cluster" },
    { name: "msg-worker", instances: 1, exec_mode: "fork" },
  ]);
});

test("neither config pings an empty daemon and names both missing paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "missing apps", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  const dumpPath = join(dir, "dump.pm2");
  writeFileSync(dumpPath, "SECRET_DUMP resurrect\n");

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, { PM2_STUB_LOG: logPath }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no config present/u);
  assert.match(result.stderr, new RegExp(appsConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, new RegExp(messagesConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(callsOf(logPath).map((call) => call.cmd), [["ping"]]);
  assert.equal(readFileSync(dumpPath, "utf8"), "SECRET_DUMP resurrect\n");
});

test("a non-zero pm2 start fails the helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "missing", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  writeFileSync(appsConfig, "INVALID_PM2_CONFIG\n");

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, { PM2_STUB_LOG: logPath }));
  assert.equal(result.status, 4);
  assert.equal(callsOf(logPath).some((call) => call.cmd[0] === "ping"), false);
  assert.equal(callsOf(logPath).some((call) => call.cmd[0] === "resurrect"), false);
});

test("an existing unreadable config fails before pm2 start", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);
  chmodSync(messagesConfig, 0o000);

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  }));
  chmodSync(messagesConfig, 0o644);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreadable/u);
  assert.equal(callsOf(logPath).length, 0);
});

test("the same config path is started once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const config = join(dir, "shared", "pm2.config.js");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, messagesFixture);

  const result = invoke(staged.script, [stubPath, config, config], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  }));
  assert.equal(result.status, 0, result.stderr);
  const calls = callsOf(logPath);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cmd, ["start", config, "--update-env"]);
  assert.equal(calls[0].apps.some((app) => app.name === "msg-worker"), true);
});

test("a refused guard records no ping or start", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);

  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    PM2_GUARD_CODE: "1",
  }));
  assert.notEqual(result.status, 0);
  assert.equal(callsOf(logPath).length, 0);
  const marks = readFileSync(staged.lifeLog, "utf8");
  assert.match(marks, /guard-begin/u);
});

test("a missing or unreadable lifecycle helper does not call pm2", () => {
  for (const mode of ["missing", "unreadable"]) {
    const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
    const staged = stage(dir, {
      helperPresent: mode !== "missing",
      helperMode: mode === "unreadable" ? 0o000 : 0o644,
    });
    const { stubPath, logPath } = writePm2Stub(dir);
    const appsConfig = join(dir, "missing apps", "pm2.config.js");
    const messagesConfig = join(dir, "missing messages", "pm2.config.js");
    const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
      PM2_STUB_LOG: logPath,
    }));
    if (mode === "unreadable") {
      chmodSync(join(dir, "pm2-lifecycle.mjs"), 0o644);
    }
    assert.notEqual(result.status, 0, mode);
    assert.match(result.stderr, /missing or unreadable/u);
    assert.equal(callsOf(logPath).length, 0, mode);
  }
});

test("a held lock keeps the next generation from starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "missing apps", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  const env = baseEnv(staged, { PM2_STUB_LOG: logPath, PM2_GUARD_SLEEP_MS: "350" });
  const started = Date.now();
  const [first, second] = await Promise.all([
    invokeAsync(staged.script, [stubPath, appsConfig, messagesConfig], env),
    invokeAsync(staged.script, [stubPath, appsConfig, messagesConfig], env),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(Date.now() - started >= 650);
  assert.deepEqual(callsOf(logPath).map((call) => call.cmd), [["ping"], ["ping"]]);
  const marks = readFileSync(staged.lifeLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const begins = marks.filter((mark) => mark.event === "guard-begin").map((mark) => mark.t);
  const ends = marks.filter((mark) => mark.event === "guard-end").map((mark) => mark.t);
  assert.equal(begins.length, 2);
  assert.ok(Math.max(...begins) >= Math.min(...ends));
});

test("lock wait counts against the global budget and a timeout does not start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const home = join(dir, "pm2home");
  mkdirSync(home);
  let now = 1_000;
  let ran = false;
  const code = await withLifecycleLock({
    io: { now: () => now, log() {} },
    pm2Home: home,
    uid: process.getuid(),
    deadlineMs: 1_000,
    acquire: async (_lockPath, waitMs) => {
      assert.ok(waitMs <= 1_000);
      now += 400;
      return async () => {};
    },
  }, async (remain) => {
    ran = true;
    assert.ok(remain <= 600);
    return 0;
  });
  assert.equal(code, 0);
  assert.equal(ran, true);
  assert.equal(statSync(join(home, "collab-lifecycle.lock")).mode & 0o777, 0o600);

  let started = false;
  const timedOut = await withLifecycleLock({
    io: { now: () => 0, log() {} },
    pm2Home: home,
    uid: process.getuid(),
    deadlineMs: 5_000,
    acquire: async () => null,
  }, async () => {
    started = true;
    return 0;
  });
  assert.equal(timedOut, 1);
  assert.equal(started, false);
});

test("a live daemon refuses the guard and does not kill", async () => {
  const fields = Array.from({ length: 20 }, () => "1");
  fields[19] = "20";
  const io = {
    readFile(file) {
      if (file === "/proc/sys/kernel/random/boot_id") return "boot-a";
      if (file === "/proc/7/stat") return `7 (God Daemon) ${fields.join(" ")}`;
      if (file === "/proc/7/status") return "Uid:\t4\t4\t4\t4\n";
      if (file === "/proc/7/environ") return "PM2_HOME=/h\0";
      const error = new Error(file);
      error.code = "ENOENT";
      throw error;
    },
    exists(file) {
      return file.endsWith("rpc.sock");
    },
    listCgroupPids() {
      return [7];
    },
    log() {},
    spawnKill() {
      throw new Error("guard must not kill");
    },
  };
  const code = await guardPm2({
    io,
    pm2Home: "/h",
    unitCgroup: "/sys/fs/cgroup/pm2.service",
    uid: 4,
    home: "/home/deploy",
    helperPid: 99,
  });
  assert.equal(code, 1);
});

test("a symlink lock path is refused and the target stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const home = join(dir, "pm2home");
  const outside = join(dir, "outside");
  mkdirSync(home);
  writeFileSync(outside, "keep\n");
  symlinkSync(outside, join(home, "collab-lifecycle.lock"));
  let started = false;
  const code = await withLifecycleLock({
    io: { now: () => 0, log() {} },
    pm2Home: home,
    uid: process.getuid(),
    deadlineMs: 1000,
    acquire: async () => async () => {},
  }, async () => {
    started = true;
    return 0;
  });
  assert.equal(code, 1);
  assert.equal(started, false);
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
});

test("a delay in the first config consumes the one budget and does not start the second", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);
  const started = Date.now();
  const result = await invokeAsync(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    PM2_STUB_SLEEP_MS: "1500",
    PM2_START_BUDGET_MS: "900",
  }));
  const elapsed = Date.now() - started;
  assert.notEqual(result.status, 0);
  assert.ok(elapsed < 5000, String(elapsed));
  assert.deepEqual(callsOf(logPath).map((call) => call.cmd), [["start", appsConfig, "--update-env"]]);
  assert.match(result.stderr, /phase=apps edge=end .* code=1/u);
  assert.equal(/phase=messages /u.test(result.stderr), false);
  assert.match(result.stderr, /phase=guard edge=end .* code=0/u);
});

test("lock wait is inside the same budget and does not start apps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  mkdirSync(`${staged.home}/collab-lifecycle.lock.hold`);
  const started = Date.now();
  const result = await invokeAsync(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    PM2_START_BUDGET_MS: "300",
  }));
  const elapsed = Date.now() - started;
  rmSync(`${staged.home}/collab-lifecycle.lock.hold`, { recursive: true, force: true });
  assert.notEqual(result.status, 0);
  assert.ok(elapsed < 2000, String(elapsed));
  assert.equal(callsOf(logPath).length, 0);
  assert.match(result.stderr, /phase=lock edge=end .* code=1/u);
  assert.equal(/phase=apps /u.test(result.stderr), false);
  assert.equal(/phase=done /u.test(result.stderr), false);
});

test("manual use outside a unit cgroup fails before any pm2 command", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir, { inUnit: false });
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);
  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /systemctl/u);
  assert.equal(callsOf(logPath).length, 0);
  assert.equal(/phase=done /u.test(result.stderr), false);
});

test("an external daemon cgroup is not adopted as success", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir, { daemonService: "other.service" });
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "missing", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /phase=done edge=end .* code=1/u);
  assert.equal(callsOf(logPath).some((call) => /resurrect|dump/u.test(call.cmd.join(" "))), false);
});

test("a missing pidfile is not success", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const staged = stage(dir);
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "missing apps", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  const result = invoke(staged.script, [stubPath, appsConfig, messagesConfig], baseEnv(staged, {
    PM2_STUB_LOG: logPath,
    PM2_STUB_SKIP_PID: "1",
  }));
  assert.notEqual(result.status, 0);
  assert.deepEqual(callsOf(logPath).map((call) => call.cmd), [["ping"]]);
  assert.match(result.stderr, /phase=done edge=end .* code=1/u);
});
