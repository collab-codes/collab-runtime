import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  listPm2,
  normalizeList,
  readPm2Version,
  resolvePm2Root,
} from "./pm2-readonly.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "pm2-readonly.mjs");

function makeInstall(root, version = "5.4.3") {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "pm2", version }),
  );
  fs.writeFileSync(path.join(root, "lib", "Client.js"), "module.exports = {};\n");
  const bin = path.join(root, "bin", "pm2");
  fs.writeFileSync(bin, "#!/bin/sh\necho SHOULD_NOT_RUN\nexit 99\n");
  fs.chmodSync(bin, 0o755);
  return bin;
}

function recordingIo(base = {}) {
  const writes = [];
  const mkdirs = [];
  const spawns = [];
  return {
    writes,
    mkdirs,
    spawns,
    realpathSync: base.realpathSync || fs.realpathSync,
    existsSync: base.existsSync || fs.existsSync,
    readFileSync: base.readFileSync || fs.readFileSync,
    lstatSync: base.lstatSync || fs.lstatSync,
    writeFileSync(p, data, enc) {
      writes.push({ p, data });
      throw new Error("must not write");
    },
    mkdirSync(p) {
      mkdirs.push(p);
      throw new Error("must not mkdir");
    },
    spawnSync(...args) {
      spawns.push(args);
      throw new Error("must not spawn");
    },
  };
}

test("version reads package.json without daemon or socket", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-ro-ver-"));
  try {
    const bin = makeInstall(tmp, "5.4.3");
    const io = recordingIo();
    const v = readPm2Version(bin, io);
    assert.equal(v, "5.4.3");
    assert.equal(io.writes.length, 0);
    assert.equal(io.spawns.length, 0);
    const r = spawnSync(process.execPath, [cli, "version", bin], {
      encoding: "utf8",
      env: { ...process.env, PM2_HOME: path.join(tmp, "no-home") },
    });
    assert.equal(r.status, EXIT.ok);
    assert.equal(r.stdout.trim(), "5.4.3");
    assert.equal(fs.existsSync(path.join(tmp, "no-home")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("list race: socket vanishes after check → unavailable, no spawn or write", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-ro-race-"));
  try {
    const bin = makeInstall(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const rpc = path.join(home, "rpc.sock");
    fs.writeFileSync(rpc, "");
    let lstatCount = 0;
    const io = recordingIo({
      lstatSync(p) {
        if (p === rpc) {
          lstatCount += 1;
          if (lstatCount === 1) {
            return {
              isSocket() {
                return true;
              },
            };
          }
          const err = new Error("gone");
          err.code = "ENOENT";
          throw err;
        }
        return fs.lstatSync(p);
      },
    });
    let transportCalls = 0;
    await assert.rejects(
      () =>
        listPm2({
          pm2Bin: bin,
          pm2Home: home,
          io,
          timeoutMs: 200,
          transport: async () => {
            transportCalls += 1;
            const err = new Error("connect");
            err.code = "unavailable";
            err.exitCode = EXIT.unavailable;
            throw err;
          },
        }),
      (err) => err.exitCode === EXIT.unavailable || err.code === "unavailable",
    );
    assert.equal(io.writes.length, 0);
    assert.equal(io.mkdirs.length, 0);
    assert.equal(io.spawns.length, 0);
    assert.ok(lstatCount >= 1);
    void transportCalls;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI list missing socket is unavailable and does not create home or spawn pm2", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-ro-cli-"));
  try {
    const bin = makeInstall(tmp);
    const home = path.join(tmp, "empty-home");
    fs.mkdirSync(home);
    const before = fs.readdirSync(home);
    const r = spawnSync(process.execPath, [cli, "list", bin], {
      encoding: "utf8",
      env: { ...process.env, PM2_HOME: home },
    });
    assert.equal(r.status, EXIT.unavailable);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /unavailable|rpc-sock/);
    assert.deepEqual(fs.readdirSync(home), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalized array keeps monitor fields and strips secrets", () => {
  const rows = normalizeList([
    {
      pm_id: 0,
      name: "msg",
      pid: 0,
      monit: { cpu: 1.2, memory: 4096 },
      pm2_env: {
        status: "stopped",
        pm_uptime: 0,
        restart_time: 3,
        exec_mode: "fork_mode",
        pmx_module: false,
        SECRET_KEY: "do-not-leak",
        args: ["--token", "abc"],
        env: { DATABASE_URL: "postgres://x" },
      },
      env: { TOKEN: "nope" },
    },
    {
      pm_id: 1,
      name: "app",
      pid: 4242,
      monit: { cpu: 0, memory: 10 },
      pm2_env: {
        status: "online",
        pm_uptime: 99,
        restart_time: 0,
        exec_mode: "cluster_mode",
        pmx_module: true,
      },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 0);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["monit", "name", "pid", "pm2_env", "pm_id"].sort());
  assert.deepEqual(Object.keys(rows[0].monit).sort(), ["cpu", "memory"]);
  assert.deepEqual(
    Object.keys(rows[0].pm2_env).sort(),
    ["exec_mode", "pm_uptime", "pmx_module", "restart_time", "status"].sort(),
  );
  assert.equal(JSON.stringify(rows).includes("do-not-leak"), false);
  assert.equal(JSON.stringify(rows).includes("DATABASE_URL"), false);
  assert.equal(JSON.stringify(rows).includes("TOKEN"), false);
  assert.equal(rows[1].pm2_env.exec_mode, "cluster_mode");
  assert.equal(rows[1].pm2_env.pmx_module, true);
});

test("empty array only from valid daemon payload", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-ro-empty-"));
  try {
    const bin = makeInstall(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const rpc = path.join(home, "rpc.sock");
    fs.writeFileSync(rpc, "");
    const io = recordingIo({
      lstatSync(p) {
        if (p === rpc) {
          return {
            isSocket() {
              return true;
            },
          };
        }
        return fs.lstatSync(p);
      },
    });
    const empty = await listPm2({
      pm2Bin: bin,
      pm2Home: home,
      io,
      transport: async () => [],
    });
    assert.deepEqual(empty, []);
    await assert.rejects(
      () =>
        listPm2({
          pm2Bin: bin,
          pm2Home: home,
          io,
          transport: async () => ({ not: "array" }),
        }),
      (err) => err.exitCode === EXIT.unavailable,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePm2Root follows realpath of the given binary", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm2-ro-link-"));
  try {
    const bin = makeInstall(tmp, "6.0.5");
    const link = path.join(tmp, "pm2-link");
    fs.symlinkSync(bin, link);
    const found = resolvePm2Root(link);
    assert.equal(found.version, "6.0.5");
    assert.equal(found.bin, fs.realpathSync(bin));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
