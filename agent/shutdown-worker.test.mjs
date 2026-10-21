import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admitShutdown, readShutdownState } from "./shutdown-state.mjs";
import { discoverPm2, execWith, failsafePlan, prepare, productionDeps, readFailsafeWith, run } from "./shutdown-worker.mjs";

const BOOT = "boot-a";
const OTHER = "boot-b";
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const WALL = Date.parse("2026-10-21T02:00:00.000Z");
const MONO = 10_000_000;
const AWS = 60 * 60 * 1000;
const SELF = 50 * 60 * 1000;
const FAILSAFE = 52 * 60 * 1000;

const config = {
  sitesUrl: "http://sites.example",
  serverId: "srv",
  projectId: "prj",
  token: "secret-token",
  agentVersion: "0.3.0",
  region: "r",
  dataRoot: "/data",
  runtimeDir: "/data/collab-runtime",
  instanceId: "i-1",
};

function clockAt(wall, mono) {
  const box = { wall, mono };
  return {
    box,
    now: () => box.wall,
    mono: () => box.mono,
  };
}

async function fixture(bootId = BOOT) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "rt116-s3-"));
  const clock = clockAt(WALL, MONO);
  const base = {
    stateDir,
    bootId,
    now: clock.now,
    mono: clock.mono,
    getuid: () => 0,
    config,
    box: clock.box,
  };
  return {
    ...base,
    async cleanup() {
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

function quietStop() {
  return { stopped: ["nginx", "msg", "redis-server", "postgresql"], notStopped: [], servicesStopped: true };
}

async function admitted(fx, id = ID) {
  const deadline = new Date(fx.box.wall + AWS).toISOString();
  const decision = await admitShutdown({ requestId: id, deadline }, fx);
  assert.equal(decision.result, "durable");
  return decision.record;
}

test("importing the worker does not run the CLI", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(here, "shutdown-worker.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  const [code, stdout] = await new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (status) => resolve([status, out]));
  });
  assert.equal(code, 2);
  assert.equal(stdout, "");
});

test("prepare accepts only after the unit start is confirmed", async () => {
  const fx = await fixture();
  try {
    const refused = await prepare(
      ["--request-id", ID, "--deadline", new Date(WALL + AWS).toISOString()],
      { ...fx, getuid: () => 50 },
    );
    assert.equal(refused.result, "rejected");
    assert.equal(refused.reason, "not_root");
    assert.equal((await readShutdownState(fx)).status, "absent");

    let starts = 0;
    const unconfirmed = await prepare(
      ["--request-id", ID, "--deadline", new Date(WALL + AWS).toISOString()],
      { ...fx, startUnit: async () => { starts += 1; return { ok: false }; } },
    );
    assert.equal(unconfirmed.result, "start_unconfirmed");
    assert.notEqual(unconfirmed.result, "accepted");
    assert.equal(starts, 1);
    assert.equal((await readShutdownState(fx)).record.requestId, ID);

    const accepted = await prepare(
      ["--request-id", ID, "--deadline", new Date(WALL + AWS).toISOString()],
      { ...fx, startUnit: async () => { starts += 1; return { ok: true }; } },
    );
    assert.equal(accepted.result, "existing");
    assert.equal(accepted.requestId, ID);
    assert.equal(starts, 2);

    const busy = await prepare(
      ["--request-id", ID2, "--deadline", new Date(WALL + AWS).toISOString()],
      { ...fx, startUnit: async () => { starts += 1; return { ok: true }; } },
    );
    assert.equal(busy.result, "busy");
    assert.equal(busy.activeRequestId, ID);
    assert.equal(starts, 2);
  } finally {
    await fx.cleanup();
  }
});

test("run stops, freezes one report, then asks for halt", async () => {
  const fx = await fixture();
  const beats = [];
  const arms = [];
  const halts = [];
  try {
    const record = await admitted(fx);
    const expectedAt = Date.parse(record.requestedAt) + FAILSAFE;
    const result = await run({
      ...fx,
      armFailsafe: async (plan) => { arms.push(plan.atMs); return { ok: true, atMs: plan.atMs }; },
      stopServices: async () => quietStop(),
      postJson: async (_url, opts) => {
        const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
        beats.push({ kind: opts.kind, body });
        return { statusCode: 204, body: "" };
      },
      poweroff: async (argv) => { halts.push(argv); return { code: 0 }; },
    });
    assert.equal(result.result, "halt_requested");
    assert.equal(result.phase, "services_stopped");
    assert.deepEqual(arms, [expectedAt]);
    assert.equal(failsafePlan(record, MONO).atMs, expectedAt);
    assert.equal(beats[0].kind, "health");
    assert.equal(beats[0].body.status !== "shutdown_ready", true);
    assert.equal(beats[0].body.payload.shutdown, undefined);
    assert.equal(beats.at(-1).body.status, "shutdown_ready");
    assert.deepEqual(beats.at(-1).body.payload.shutdown.stopped, quietStop().stopped);
    assert.equal(beats.at(-1).body.payload.shutdown.requestId, ID);
    assert.equal(JSON.stringify(beats.at(-1).body.payload.shutdown).includes("secret-token"), false);
    assert.deepEqual(halts, [["/usr/sbin/shutdown", "-h", "now"]]);
    const stored = await readShutdownState(fx);
    assert.equal(stored.record.poweroffRequestedAt !== null, true);
    assert.equal(stored.record.report.finishedAt, result.report.finishedAt);
    assert.equal(stored.record.bootId, BOOT);
  } finally {
    await fx.cleanup();
  }
});

test("heartbeat and poweroff errors still request halt inside the same id", async () => {
  const fx = await fixture();
  let posts = 0;
  const halts = [];
  try {
    await admitted(fx);
    const first = await run({
      ...fx,
      armFailsafe: async (plan) => ({ ok: true, atMs: plan.atMs }),
      stopServices: async () => quietStop(),
      postJson: async () => { posts += 1; throw new Error("offline"); },
      poweroff: async () => { halts.push("once"); return { code: 1 }; },
    });
    assert.equal(first.result, "halt_requested");
    assert.equal(first.heartbeatAttempts, 3);
    assert.equal(first.poweroffCode, 1);
    const saved = await readShutdownState(fx);
    const second = await run({
      ...fx,
      armFailsafe: async (plan) => ({ ok: true, atMs: plan.atMs }),
      stopServices: async () => { throw new Error("should not drain again"); },
      postJson: async () => ({ statusCode: 204, body: "" }),
      poweroff: async () => { halts.push("twice"); return { code: 0 }; },
    });
    assert.equal(second.requestId, ID);
    assert.equal(second.report.finishedAt, saved.record.report.finishedAt);
    assert.equal(second.report.startedAt, saved.record.report.startedAt);
    assert.equal(second.failsafeAtMs, first.failsafeAtMs);
    assert.deepEqual(halts, ["once", "twice"]);
    assert.equal(posts, 4);
  } finally {
    await fx.cleanup();
  }
});

test("a crash after the poweroff intent retries halt and does not move the timer", async () => {
  const fx = await fixture();
  const arms = [];
  try {
    await admitted(fx);
    const crashed = await run({
      ...fx,
      armFailsafe: async (plan) => { arms.push(plan.atMs); return { ok: true, atMs: plan.atMs }; },
      stopServices: async () => quietStop(),
      postJson: async () => ({ statusCode: 204, body: "" }),
      poweroff: async () => { throw new Error("crash-after-intent"); },
    });
    assert.equal(crashed.result, "halt_requested");
    assert.equal(crashed.poweroffCode, null);
    const mid = await readShutdownState(fx);
    assert.equal(mid.record.poweroffRequestedAt !== null, true);
    const again = await run({
      ...fx,
      readFailsafe: async () => ({ atMs: arms[0] }),
      armFailsafe: async (plan) => { arms.push(plan.atMs); return { ok: true, atMs: plan.atMs + 60_000 }; },
      stopServices: async () => { throw new Error("no second drain"); },
      postJson: async () => ({ statusCode: 204, body: "" }),
      poweroff: async () => ({ code: 0 }),
    });
    assert.equal(again.requestId, ID);
    assert.equal(again.failsafeAtMs, arms[0]);
    assert.equal(arms.length, 1);
    assert.equal(again.poweroffRequestedAt, mid.record.poweroffRequestedAt);
  } finally {
    await fx.cleanup();
  }
});

test("a stuck drain keeps the original failsafe and does not claim those services stopped", async () => {
  const fx = await fixture();
  let entered = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const arms = [];
  const halts = [];
  try {
    const record = await admitted(fx);
    const pending = run({
      ...fx,
      armFailsafe: async (plan) => { arms.push(plan.atMs); return { ok: true, atMs: plan.atMs }; },
      stopServices: async () => {
        entered = true;
        await gate;
        return { stopped: ["nginx"], notStopped: ["msg"], servicesStopped: false };
      },
      postJson: async () => ({ statusCode: 204, body: "" }),
      poweroff: async () => { halts.push(1); return { code: 0 }; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(arms, [Date.parse(record.requestedAt) + FAILSAFE]);
    assert.deepEqual(halts, []);
    release();
    const result = await pending;
    assert.equal(result.phase, "failed");
    assert.deepEqual(result.report.notStopped, ["msg"]);
    assert.equal(result.report.stopped.includes("msg"), false);
  } finally {
    await fx.cleanup();
  }
});

test("a late request skips the drain and still asks for halt", async () => {
  const fx = await fixture();
  let drained = false;
  try {
    await admitted(fx);
    fx.box.mono = MONO + SELF - 30_000;
    fx.box.wall = WALL + SELF - 30_000;
    const result = await run({
      ...fx,
      armFailsafe: async (plan) => ({ ok: true, atMs: plan.atMs }),
      stopServices: async () => { drained = true; return quietStop(); },
      postJson: async () => ({ statusCode: 204, body: "" }),
      poweroff: async () => ({ code: 0 }),
    });
    assert.equal(drained, false);
    assert.equal(result.phase, "deadline_exceeded");
    assert.equal(result.report.notStopped.length > 0, true);
    assert.deepEqual(result.report.stopped, []);
    assert.equal(result.result, "halt_requested");
  } finally {
    await fx.cleanup();
  }
});

test("another boot does not arm a timer or halt", async () => {
  const fx = await fixture();
  let armed = false;
  let halted = false;
  try {
    await admitted(fx);
    const result = await run({
      ...fx,
      bootId: OTHER,
      armFailsafe: async () => { armed = true; return { ok: true, atMs: 1 }; },
      poweroff: async () => { halted = true; return { code: 0 }; },
    });
    assert.equal(result.result, "stale_boot");
    assert.equal(armed, false);
    assert.equal(halted, false);
    const still = await readShutdownState(fx);
    assert.equal(still.status, "active");
    assert.equal(still.record.phase, "requested");
  } finally {
    await fx.cleanup();
  }
});

test("when the failsafe cannot be armed the worker halts without the long drain", async () => {
  const fx = await fixture();
  let drained = false;
  try {
    await admitted(fx);
    const result = await run({
      ...fx,
      armFailsafe: async () => ({ ok: false, reason: "systemd" }),
      stopServices: async () => { drained = true; return quietStop(); },
      postJson: async () => ({ statusCode: 500, body: "" }),
      poweroff: async () => ({ code: 0 }),
    });
    assert.equal(drained, false);
    assert.equal(result.phase, "failed");
    assert.equal(result.report.notStopped.length > 0, true);
    assert.equal(result.result, "halt_requested");
    assert.equal(result.heartbeatAttempts, 3);
  } finally {
    await fx.cleanup();
  }
});

test("service observation persists before the stop and does not call the host", async () => {
  const fx = await fixture();
  const events = [];
  const show = "loaded\nactive\nrunning\n4242\n1\n";
  const quiet = "loaded\ninactive\ndead\n0\n0\n";
  let nginxShows = 0;
  try {
    await admitted(fx);
    const result = await run({
      ...fx,
      pm2: { user: "ubuntu", home: "/home/ubuntu/.pm2" },
      armFailsafe: async (plan) => ({ ok: true, atMs: plan.atMs }),
      postJson: async () => ({ statusCode: 204, body: "" }),
      poweroff: async () => ({ code: 0 }),
      persist: async (intent) => { events.push(`persist:${intent.name}`); },
      exec: async (argv) => {
        events.push(argv.join(" "));
        if (argv.includes("jlist")) return { code: 0, stdout: "[]" };
        if (argv[1] === "list-units") return { code: 0, stdout: "" };
        if (argv[1] === "show" && argv[2] === "nginx.service") {
          nginxShows += 1;
          return { code: 0, stdout: nginxShows === 1 ? show : quiet };
        }
        if (argv[1] === "show") return { code: 0, stdout: "not-found\n\n\n\n\n" };
        return { code: 0, stdout: "" };
      },
    });
    const persistAt = events.indexOf("persist:nginx");
    const stopAt = events.findIndex((line) => line.startsWith("systemctl stop nginx.service"));
    assert.equal(persistAt >= 0 && stopAt > persistAt, true);
    assert.equal(result.report.stopped.includes("nginx"), true);
    assert.equal(result.report.notStopped.includes("nginx"), false);
    const raw = await readFile(path.join(fx.stateDir, "current.json"), "utf8");
    assert.equal(raw.includes("secret-token"), false);
  } finally {
    await fx.cleanup();
  }
});

test("start --no-block exit 0 alone is not acceptance: the unit must be seen activating or active", async () => {
  const { startUnitWith } = await import("./shutdown-worker.mjs");
  const runner = (states, startCode = 0) => {
    const calls = [];
    const run = async (argv) => {
      calls.push(argv.join(" "));
      if (argv[1] === "start") return { code: startCode, stdout: "" };
      return { code: 0, stdout: `${states.shift() ?? "inactive"}\n` };
    };
    return { run, calls };
  };
  const noSleep = async () => {};
  const ok = runner(["inactive", "activating"]);
  assert.equal((await startUnitWith(ok.run, noSleep)).ok, true);
  assert.equal((await startUnitWith(runner(["failed"]).run, noSleep)).ok, false);
  const never = runner([]);
  const notRunning = await startUnitWith(never.run, noSleep, 3, 0);
  assert.equal(notRunning.ok, false);
  assert.equal(notRunning.reason, "unit_not_running");
  assert.equal((await startUnitWith(runner([], 1).run, noSleep)).reason, "start_refused");
});

const FIXED_EXEC = "{ path=/usr/local/lib/collab/pm2-start-fixed.sh ; argv[]=/usr/local/lib/collab/pm2-start-fixed.sh /usr/lib/node_modules/pm2/bin/pm2 /data/mls-base/pm2.config.js ; }";

function systemdFake(units) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.slice());
    if (argv[1] === "list-units") {
      return { code: 0, stdout: Object.keys(units).map((unit) => `${unit} loaded active running PM2\n`).join("") };
    }
    if (argv[1] === "show" && argv[2].endsWith(".timer")) return { code: 0, stdout: "inactive\n" };
    if (argv[1] === "show") {
      const unit = units[argv[2]];
      if (!unit) return { code: 1, stdout: "" };
      return { code: 0, stdout: `ExecStart=${unit.exec}\nUser=${unit.user ?? ""}\nEnvironment=${unit.env ?? ""}\n` };
    }
    return { code: 1, stdout: "" };
  };
  return { run, calls };
}

test("production deps read the boot id, the env path and the business pm2 from systemd", async () => {
  const logs = [];
  const { run } = systemdFake({
    "pm2-root.service": { exec: "{ path=/usr/lib/node_modules/pm2/bin/pm2 ; argv[]=pm2 resurrect ; }" },
    "pm2-ana.service": { exec: FIXED_EXEC, user: "ana", env: "PATH=/usr/bin PM2_HOME=/home/ana.guest/.pm2" },
  });
  const deps = await productionDeps({ run, readBootId: () => "boot-real", log: (line) => logs.push(line) });
  assert.equal(deps.bootId, "boot-real");
  assert.equal(deps.envPath, "/etc/collab/sites-agent.env");
  assert.deepEqual(deps.pm2, { user: "ana", home: "/home/ana.guest/.pm2" });
  for (const key of ["now", "mono", "exec", "sleep", "log", "readFailsafe"]) assert.equal(typeof deps[key], "function", key);
  const a = deps.mono();
  assert.ok(Number.isInteger(a) && a > 0);
  const echoed = await deps.exec(["/bin/echo", "hi"], { timeoutMs: 5_000 });
  assert.equal(echoed.code, 0);
  assert.equal(echoed.stdout, "hi\n");
  assert.equal(await deps.readFailsafe({ unit: "collab-shutdown-failsafe-x", atMs: 5 }), null);
  assert.ok(logs.some((line) => line.includes("unit=pm2-ana.service")));
});

test("zero, two or an incomplete pm2 unit leave the target unknown and say why", async () => {
  const cases = [
    [{}, "pm2_unit_absent"],
    [{
      "pm2-a.service": { exec: FIXED_EXEC, user: "a", env: "PM2_HOME=/home/a/.pm2" },
      "pm2-b.service": { exec: FIXED_EXEC, user: "b", env: "PM2_HOME=/home/b/.pm2" },
    }, "pm2_unit_ambiguous"],
    [{ "pm2-a.service": { exec: FIXED_EXEC, user: "a", env: "PATH=/usr/bin" } }, "pm2_unit_incomplete"],
  ];
  for (const [units, reason] of cases) {
    assert.equal((await discoverPm2(systemdFake(units).run)).reason, reason);
    const logs = [];
    const deps = await productionDeps({ run: systemdFake(units).run, readBootId: () => "b", log: (line) => logs.push(line) });
    assert.deepEqual(deps.pm2, {});
    assert.ok(logs.some((line) => line.includes(`result=${reason}`)), reason);
  }
});

test("a restarted worker sees the timer it armed instead of arming a second one", async () => {
  const run = async () => ({ code: 0, stdout: "active\n" });
  assert.deepEqual(await readFailsafeWith(run, { unit: "collab-shutdown-failsafe-x", atMs: 77 }), { atMs: 77 });
});

test("the exec adapter honors timeoutMs in the options object and the abort signal", async () => {
  const exec = execWith(spawn);
  const ok = await exec(["/bin/echo", "hi"], { timeoutMs: 5_000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "hi\n");
  const started = Date.now();
  const slow = await exec(["/bin/sleep", "5"], { timeoutMs: 200 });
  assert.equal(slow.code, null);
  assert.equal(slow.timeout, true);
  assert.ok(Date.now() - started < 3_000);
  const controller = new AbortController();
  const pending = exec(["/bin/sleep", "5"], { timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const aborted = await pending;
  assert.equal(aborted.aborted, true);
});
