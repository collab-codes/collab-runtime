import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
const logPath = process.env.PM2_STUB_LOG;
const args = process.argv.slice(2);
const forbidden = args.some((arg) => /resurrect|dump|save|startup/u.test(arg));
if (forbidden) {
  appendFileSync(logPath, JSON.stringify({ cmd: args, forbidden: true }) + "\\n");
  process.exit(99);
}
if (args.length === 1 && args[0] === "ping") {
  appendFileSync(logPath, JSON.stringify({ cmd: args }) + "\\n");
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

function invoke(args, env) {
  return spawnSync("bash", [helper, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("starts apps then messages and keeps the worker when the external flag is false", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "path with spaces", "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "path with spaces", "msg.collab.codes", "pm2.config.js");
  const dumpPath = join(dir, "dump.pm2");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);
  writeFileSync(dumpPath, "SECRET_DUMP resurrect app-from-dump\n");

  const result = invoke([stubPath, appsConfig, messagesConfig], {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
    NODE_ENV: "production",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
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
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);

  const result = invoke([stubPath, appsConfig, messagesConfig], {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`config absent: ${messagesConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const calls = callsOf(logPath);
  assert.deepEqual(calls.map((call) => call.cmd), [["start", appsConfig, "--update-env"]]);
  assert.equal(calls[0].apps[0].instances, 2);
});

test("messages only still loads msg-worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "no apps", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(messagesConfig, messagesFixture);

  const result = invoke([stubPath, appsConfig, messagesConfig], {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  });
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
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "missing apps", "pm2.config.js");
  const messagesConfig = join(dir, "missing messages", "pm2.config.js");
  const dumpPath = join(dir, "dump.pm2");
  writeFileSync(dumpPath, "SECRET_DUMP resurrect\n");

  const result = invoke([stubPath, appsConfig, messagesConfig], { PM2_STUB_LOG: logPath });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no config present/u);
  assert.match(result.stderr, new RegExp(appsConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, new RegExp(messagesConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(callsOf(logPath).map((call) => call.cmd), [["ping"]]);
  assert.equal(readFileSync(dumpPath, "utf8"), "SECRET_DUMP resurrect\n");
});

test("a non-zero pm2 start fails the helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "missing", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  writeFileSync(appsConfig, "INVALID_PM2_CONFIG\n");

  const result = invoke([stubPath, appsConfig, messagesConfig], { PM2_STUB_LOG: logPath });
  assert.equal(result.status, 4);
  assert.equal(callsOf(logPath).some((call) => call.cmd[0] === "ping"), false);
  assert.equal(callsOf(logPath).some((call) => call.cmd[0] === "resurrect"), false);
});

test("an existing unreadable config fails before pm2 start", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const { stubPath, logPath } = writePm2Stub(dir);
  const appsConfig = join(dir, "mls-base", "pm2.config.js");
  const messagesConfig = join(dir, "msg.collab.codes", "pm2.config.js");
  mkdirSync(dirname(appsConfig), { recursive: true });
  mkdirSync(dirname(messagesConfig), { recursive: true });
  writeFileSync(appsConfig, appsFixture);
  writeFileSync(messagesConfig, messagesFixture);
  chmodSync(messagesConfig, 0o000);

  const result = invoke([stubPath, appsConfig, messagesConfig], {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  });
  chmodSync(messagesConfig, 0o644);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreadable/u);
  assert.equal(callsOf(logPath).length, 0);
});

test("the same config path is started once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-start-fixed-"));
  const { stubPath, logPath } = writePm2Stub(dir);
  const config = join(dir, "shared", "pm2.config.js");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, messagesFixture);

  const result = invoke([stubPath, config, config], {
    PM2_STUB_LOG: logPath,
    COLLAB_MESSAGES_ENABLE_WORKER: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = callsOf(logPath);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cmd, ["start", config, "--update-env"]);
  assert.equal(calls[0].apps.some((app) => app.name === "msg-worker"), true);
});
