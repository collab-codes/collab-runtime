import assert from "node:assert/strict";
import { test } from "node:test";
import { PM2_STOP_PHASES, planPm2StopOrder, runPm2StopOrder } from "./pm2-stop-order.mjs";

function row(name, pmId, pid, extra = {}) {
  return { name, pm_id: pmId, pid, pm2_env: { status: pid > 0 ? "online" : "stopped", pm_uptime: 1000 + pmId, pmx_module: false, ...extra } };
}

/** Fake PM2 world with a manual clock. `exitOn` decides which names really exit on stop. */
function world(rows, { exitOn = () => true, observeOk = () => true } = {}) {
  const state = rows.map((r) => ({ ...r, pm2_env: { ...r.pm2_env } }));
  const calls = [];
  let t = 0;
  return {
    calls,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    stop: async (phase, deadlineAt) => {
      calls.push({ phase: phase.phase, names: [...phase.names], deadlineAt, aliveAtStop: state.filter((r) => r.pid > 0).map((r) => r.name) });
      for (const r of state) if (phase.names.includes(r.name) && exitOn(r.name)) r.pid = 0;
    },
    observe: async () => (observeOk() ? { ok: true, processes: state.map((r) => ({ ...r })) } : { ok: false }),
    kill: (name) => { for (const r of state) if (r.name === name) r.pid = 0; },
    state,
  };
}

const full = () => [
  row("msg", 0, 10),
  row("msg-worker", 1, 11),
  row("shop", 2, 20),
  row("shop", 3, 21),
  row("agenda", 4, 22),
  row("pm2-logrotate", 5, 30, { pmx_module: true }),
];

test("plan: ordered phases, names deduplicated, instances kept, modules apart", () => {
  const plan = planPm2StopOrder(full());
  assert.deepEqual(plan.phases.map((p) => p.phase), [...PM2_STOP_PHASES]);
  assert.deepEqual(plan.phases[0].names, ["agenda", "shop"]);
  assert.deepEqual(plan.phases[0].instances.map((i) => i.pid).sort(), [20, 21, 22]);
  assert.deepEqual(plan.phases[1].names, ["msg-worker"]);
  assert.deepEqual(plan.phases[2].names, ["msg"]);
  assert.deepEqual(plan.modules, ["pm2-logrotate"]);
  for (const p of plan.phases) assert.ok(!p.names.includes("pm2-logrotate"));
});

test("happy path: apps -> msg-worker -> msg, each started only after the previous is gone", async () => {
  const w = world(full());
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 1000, stop: w.stop, observe: w.observe, now: w.now, sleep: w.sleep, pollMs: 10 });
  assert.equal(out.ok, true);
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps", "msg-worker", "msg"]);
  assert.ok(!w.calls[1].aliveAtStop.some((n) => n === "shop" || n === "agenda"));
  assert.ok(!w.calls[2].aliveAtStop.includes("msg-worker"));
  assert.ok(w.calls[2].aliveAtStop.includes("pm2-logrotate"), "module left for the daemon close");
  assert.deepEqual(out.phases.map((p) => p.result), ["stopped", "stopped", "stopped"]);
});

test("barrier: a live app blocks both messages phases", async () => {
  const w = world(full(), { exitOn: (n) => n !== "shop" });
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 100, stop: w.stop, observe: w.observe, now: w.now, sleep: w.sleep, pollMs: 10 });
  assert.equal(out.ok, false);
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps"]);
  assert.deepEqual(out.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);
});

test("barrier: app confirmed gone releases worker; live worker blocks msg", async () => {
  const w = world(full(), { exitOn: (n) => n !== "msg-worker" });
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 100, stop: w.stop, observe: w.observe, now: w.now, sleep: w.sleep, pollMs: 10 });
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps", "msg-worker"]);
  assert.deepEqual(out.phases.map((p) => p.result), ["stopped", "unconfirmed", "blocked"]);
});

test("slow exit observed later still advances, within one budget", async () => {
  const w = world(full(), { exitOn: (n) => n !== "agenda" });
  const stop = async (phase, d) => {
    await w.stop(phase, d);
    if (phase.phase === "apps") setTimeoutLike(() => w.kill("agenda"));
  };
  let pending = null;
  const setTimeoutLike = (fn) => { pending = fn; };
  const sleep = async (ms) => { await w.sleep(ms); if (pending) { pending(); pending = null; } };
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 1000, stop, observe: w.observe, now: w.now, sleep, pollMs: 10 });
  assert.equal(out.ok, true);
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps", "msg-worker", "msg"]);
});

test("unconfirmed observation or failed action blocks the next phase", async () => {
  let reads = 0;
  const w = world(full(), { observeOk: () => ++reads > 1 });
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 1000, stop: w.stop, observe: w.observe, now: w.now, sleep: w.sleep });
  assert.deepEqual(out.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps"]);

  const w2 = world(full());
  const out2 = await runPm2StopOrder({ inventory: w2.state, remainingMs: 1000, stop: async () => false, observe: w2.observe, now: w2.now, sleep: w2.sleep });
  assert.deepEqual(out2.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);

  const w3 = world(full());
  const out3 = await runPm2StopOrder({ inventory: w3.state, remainingMs: 1000, stop: async () => { throw new Error("x"); }, observe: w3.observe, now: w3.now, sleep: w3.sleep });
  assert.equal(out3.ok, false);
});

test("command exit 0 is not proof: process still listed keeps the barrier", async () => {
  const w = world(full(), { exitOn: () => false });
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 50, stop: async (p) => { await w.stop(p); return true; }, observe: w.observe, now: w.now, sleep: w.sleep, pollMs: 10 });
  assert.deepEqual(out.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);
});

test("absent msg-worker and msg are explicit not_applicable; no apps goes straight on", async () => {
  const w = world([row("shop", 0, 20)]);
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 100, stop: w.stop, observe: w.observe, now: w.now, sleep: w.sleep });
  assert.equal(out.ok, true);
  assert.deepEqual(out.phases.map((p) => p.result), ["stopped", "not_applicable", "not_applicable"]);
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps"]);

  const w2 = world([row("msg", 0, 10), row("pm2-logrotate", 1, 30, { pmx_module: true }), row("old", 2, 0)]);
  const out2 = await runPm2StopOrder({ inventory: w2.state, remainingMs: 100, stop: w2.stop, observe: w2.observe, now: w2.now, sleep: w2.sleep });
  assert.deepEqual(out2.phases.map((p) => p.result), ["not_applicable", "not_applicable", "stopped"]);
  assert.deepEqual(w2.calls.map((c) => c.phase), ["msg"]);
  assert.deepEqual(out2.modules, ["pm2-logrotate"]);
});

test("one budget for all phases: exhausted without advancing the dependency", async () => {
  // apps take 60ms to exit, worker never confirms; total budget 100ms, not 100ms per phase.
  const w = world(full(), { exitOn: (n) => n === "msg" });
  let appsStoppedAt = null;
  const stop = async (phase, deadlineAt) => {
    await w.stop(phase, deadlineAt);
    if (phase.phase === "apps") appsStoppedAt = w.now();
  };
  const observe = async () => {
    if (appsStoppedAt !== null && w.now() - appsStoppedAt >= 60) { w.kill("shop"); w.kill("agenda"); }
    return w.observe();
  };
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 100, stop, observe, now: w.now, sleep: w.sleep, pollMs: 10 });
  assert.deepEqual(out.phases.map((p) => p.result), ["stopped", "unconfirmed", "blocked"]);
  assert.equal(w.calls[0].deadlineAt, 100);
  assert.equal(w.calls[1].deadlineAt, 100, "same absolute deadline, never summed per phase");
  assert.ok(w.now() <= 100);
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps", "msg-worker"]);
});

test("abort and zero budget send no stop", async () => {
  const ac = new AbortController();
  ac.abort();
  const w = world(full());
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 1000, stop: w.stop, observe: w.observe, now: w.now, sleep: w.sleep, signal: ac.signal });
  assert.equal(w.calls.length, 0);
  assert.deepEqual(out.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);

  const w2 = world(full());
  const out2 = await runPm2StopOrder({ inventory: w2.state, remainingMs: 0, stop: w2.stop, observe: w2.observe, now: w2.now, sleep: w2.sleep });
  assert.equal(w2.calls.length, 0);
  assert.equal(out2.ok, false);
});

test("abort during the wait blocks the next phase", async () => {
  const ac = new AbortController();
  const w = world(full(), { exitOn: () => false });
  const sleep = async (ms) => { await w.sleep(ms); ac.abort(); };
  const out = await runPm2StopOrder({ inventory: w.state, remainingMs: 1000, stop: w.stop, observe: w.observe, now: w.now, sleep, signal: ac.signal, pollMs: 10 });
  assert.deepEqual(w.calls.map((c) => c.phase), ["apps"]);
  assert.deepEqual(out.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);
});

test("restarted instance under a new pid keeps the phase alive", async () => {
  const w = world(full());
  const stop = async (phase, d) => {
    await w.stop(phase, d);
    if (phase.phase === "apps") w.state.push(row("shop", 9, 99));
  };
  const out = await runPm2StopOrder({ inventory: full(), remainingMs: 50, stop, observe: w.observe, now: w.now, sleep: w.sleep, pollMs: 10 });
  assert.deepEqual(out.phases.map((p) => p.result), ["unconfirmed", "blocked", "blocked"]);
});
