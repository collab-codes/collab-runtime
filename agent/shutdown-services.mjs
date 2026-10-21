// Ordered stop of managed services. Commands, clock and observation are injected.
// This module never stops the host by itself and never builds a shell from data.
import { procIdentity } from "../scripts/pm2-lifecycle.mjs";

export const PLATFORM_PM2 = Object.freeze(["msg-worker", "msg"]);
const PLATFORM_SET = new Set(PLATFORM_PM2);
const CUTOFF_MARGIN_MS = 60_000;
const NAME_RE = /^[A-Za-z0-9_.:@+-]{1,128}$/;
const UNIT_RE = /^[A-Za-z0-9_.:@+-]{1,128}$/;
const PG_UNIT_RE = /^postgresql@[A-Za-z0-9_.+-]+\.service$/;
const PM2_HOME_RE = /^\/[A-Za-z0-9_./-]{1,256}$/;
const USER_RE = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * @typedef {"stopped"|"not_applicable"|"unconfirmed"} StopResult
 */

/**
 * Stop managed units and PM2 apps before Redis and PostgreSQL.
 * A truthy `servicesStopped` means every observed business process and the
 * data services were confirmed stopped or not installed. A read failure is
 * never an empty success.
 *
 * @param {object} deps
 * @param {string} deps.requestId
 * @param {number} deps.selfDeadlineAt epoch ms
 * @param {() => number} deps.now
 * @param {() => number} deps.mono
 * @param {AbortSignal} [deps.signal]
 * @param {string} [deps.pm2User] unknown or invalid: pm2 inventory is unconfirmed
 * @param {string} [deps.pm2Home]
 * @param {string} [deps.bootId]
 * @param {(line: string) => void} [deps.log]
 * @param {(intent: object) => Promise<void>} deps.persist
 * @param {(argv: string[], opts: { timeoutMs: number, signal?: AbortSignal }) => Promise<{ code: number|null, stdout?: string }>} deps.exec
 * @param {{ inflight: Promise<{ code: number|null, stdout?: string }>|null }} [deps.control]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.pollMs]
 */
export async function stopServices(deps) {
  assertDeps(deps);
  const origin = {
    mono: deps.mono(),
    wallLeft: deps.selfDeadlineAt - CUTOFF_MARGIN_MS - deps.now(),
  };
  const effects = [];
  const log = (line) => {
    if (typeof deps.log === "function") deps.log(line);
  };

  const nginx = await stopUnit(deps, origin, "nginx", "nginx.service", log);
  effects.push(nginx);

  const inventory = await readPm2(deps, origin);
  const pm2Effects = [];
  if (!inventory.ok) {
    pm2Effects.push(effect("pm2", "pm2-inventory", "unconfirmed", []));
    log("stage=pm2-inventory result=unconfirmed");
  } else {
    const apps = selectApps(inventory.processes);
    for (const name of apps.early) {
      pm2Effects.push(await stopPm2Name(deps, origin, inventory, name, "pm2-apps", log));
    }
    pm2Effects.push(await stopPm2Name(deps, origin, inventory, "msg-worker", "msg-worker", log));
    pm2Effects.push(await stopPm2Name(deps, origin, inventory, "msg", "msg", log));
    const again = await readPm2(deps, origin);
    if (!again.ok) {
      pm2Effects.push(effect("pm2", "pm2-confirm", "unconfirmed", []));
      log("stage=pm2-confirm result=unconfirmed");
    } else {
      const live = businessLive(again.processes);
      if (live.length === 0) {
        pm2Effects.push(effect("pm2", "pm2-confirm", "stopped", []));
        log("stage=pm2-confirm result=stopped");
      } else {
        for (const proc of live) {
          pm2Effects.push(effect(proc.name, "pm2-confirm", "unconfirmed", [identityOf(deps, proc)]));
          log(`stage=pm2-confirm name=${proc.name} result=unconfirmed`);
        }
      }
    }
  }
  effects.push(...pm2Effects);

  const appsClear = pm2Effects.every((item) => item.result !== "unconfirmed");
  if (!appsClear || aborted(deps)) {
    const redis = await observeOnly(deps, origin, "redis-server", "redis-server.service", log);
    const pg = await observePostgresql(deps, origin, log, false);
    effects.push(redis, ...pg);
  } else {
    effects.push(await stopUnit(deps, origin, "redis-server", "redis-server.service", log));
    effects.push(...(await observePostgresql(deps, origin, log, true)));
  }

  const stopped = [];
  const notStopped = [];
  for (const item of effects) {
    if (item.result === "stopped" && item.name !== "pm2") pushUnique(stopped, item.name);
    if (item.result === "unconfirmed") pushUnique(notStopped, item.name);
  }
  for (const name of notStopped) {
    const at = stopped.indexOf(name);
    if (at >= 0) stopped.splice(at, 1);
  }
  return {
    requestId: deps.requestId,
    stopped,
    notStopped,
    effects,
    servicesStopped: notStopped.length === 0 && !aborted(deps),
  };
}

function assertDeps(deps) {
  if (!deps || typeof deps.requestId !== "string" || deps.requestId.length === 0) {
    throw new TypeError("requestId");
  }
  if (!Number.isFinite(deps.selfDeadlineAt)) throw new TypeError("selfDeadlineAt");
  if (typeof deps.now !== "function" || typeof deps.mono !== "function") throw new TypeError("clock");
  if (typeof deps.persist !== "function" || typeof deps.exec !== "function") throw new TypeError("io");
}

// An unknown pm2 target is an unconfirmed inventory, not an exception: the
// report still freezes, the heartbeat still goes and the halt still happens.
function pm2TargetKnown(deps) {
  return USER_RE.test(deps.pm2User ?? "") && PM2_HOME_RE.test(deps.pm2Home ?? "");
}

function remainingMs(deps, origin) {
  const wallLeft = deps.selfDeadlineAt - CUTOFF_MARGIN_MS - deps.now();
  const monoLeft = origin.wallLeft - (deps.mono() - origin.mono);
  return Math.min(wallLeft, monoLeft);
}

function aborted(deps) {
  return Boolean(deps.signal?.aborted);
}

function effect(name, stage, result, identities) {
  return { name, stage, result, identities };
}

function pushUnique(list, name) {
  if (!list.includes(name)) list.push(name);
}

function identityOf(deps, proc) {
  const bootId = typeof deps.bootId === "string" && deps.bootId.length > 0 ? deps.bootId : "unknown";
  return procIdentity(bootId, proc.pid, proc.startTime);
}

/**
 * @param {{ name: string, pid: number, status: string, startTime: number }[]} processes
 */
export function selectApps(processes) {
  const early = [];
  for (const proc of processes) {
    if (!proc || proc.alive !== true) continue;
    if (PLATFORM_SET.has(proc.name)) continue;
    if (!early.includes(proc.name)) early.push(proc.name);
  }
  early.sort();
  return { early };
}

function businessLive(processes) {
  return processes.filter((proc) => proc && proc.alive === true);
}

async function stopUnit(deps, origin, name, unit, log) {
  const seen = await showUnit(deps, origin, unit);
  if (seen.result !== "running") {
    log(`stage=${name} result=${seen.result}`);
    return effect(name, name, seen.result, []);
  }
  const argv = ["systemctl", "stop", unit];
  let ran = await runControl(deps, origin, name, name, argv);
  if (ran.kind === "observed") {
    const mid = await showUnit(deps, origin, unit);
    if (mid.result !== "running") {
      log(`stage=${name} result=${mid.result}`);
      return effect(name, name, mid.result, []);
    }
    ran = await runControl(deps, origin, name, name, argv);
  }
  if (ran.kind === "skipped" || ran.kind === "aborted" || ran.kind === "unconfirmed") {
    log(`stage=${name} result=unconfirmed`);
    return effect(name, name, "unconfirmed", []);
  }
  const after = await showUnit(deps, origin, unit);
  const result = after.result === "running" ? "unconfirmed" : after.result;
  log(`stage=${name} result=${result}`);
  return effect(name, name, result, []);
}

async function observeOnly(deps, origin, name, unit, log) {
  const seen = await showUnit(deps, origin, unit);
  const result = seen.result === "running" ? "unconfirmed" : seen.result;
  log(`stage=${name} result=${result} observe=only`);
  return effect(name, name, result, []);
}

async function showUnit(deps, origin, unit) {
  if (!UNIT_RE.test(unit)) return { result: "unconfirmed" };
  const ran = await runObserve(deps, origin, [
    "systemctl", "show", unit,
    "-p", "LoadState",
    "-p", "ActiveState",
    "-p", "SubState",
    "-p", "MainPID",
    "-p", "TasksCurrent",
    "--value",
  ]);
  if (ran.kind !== "ok" || ran.code !== 0) return { result: "unconfirmed" };
  const parsed = parseShow(ran.stdout);
  if (parsed.LoadState === "not-found") return { result: "not_applicable" };
  if (unitQuiet(parsed)) return { result: "stopped" };
  return { result: "running" };
}

function parseShow(stdout) {
  const lines = String(stdout ?? "").split("\n");
  return {
    LoadState: lines[0] ?? "",
    ActiveState: lines[1] ?? "",
    SubState: lines[2] ?? "",
    MainPID: lines[3] ?? "",
    TasksCurrent: lines[4] ?? "",
  };
}

function unitQuiet(parsed) {
  const inactive = parsed.ActiveState === "inactive" || parsed.ActiveState === "failed";
  const pid = Number(parsed.MainPID);
  const noPid = parsed.MainPID === "" || pid === 0;
  const tasks = parsed.TasksCurrent.trim();
  const noTasks = tasks === "" || tasks === "0" || tasks === "[not set]";
  return inactive && noPid && noTasks;
}

async function observePostgresql(deps, origin, log, allowStop) {
  const listed = await runObserve(deps, origin, [
    "systemctl", "list-units", "postgresql@*.service",
    "--all", "--plain", "--no-legend", "--no-pager",
  ]);
  if (listed.kind !== "ok" || listed.code !== 0) {
    log("stage=postgresql result=unconfirmed");
    return [effect("postgresql", "postgresql", "unconfirmed", [])];
  }
  const units = [];
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (!name) continue;
    if (!PG_UNIT_RE.test(name)) {
      log("stage=postgresql result=unconfirmed");
      return [effect("postgresql", "postgresql", "unconfirmed", [])];
    }
    units.push(name);
  }
  if (units.length === 0) {
    const umbrella = await showUnit(deps, origin, "postgresql.service");
    if (umbrella.result === "running") {
      log("stage=postgresql result=unconfirmed");
      return [effect("postgresql", "postgresql", "unconfirmed", [])];
    }
    log(`stage=postgresql result=${umbrella.result}`);
    return [effect("postgresql", "postgresql", umbrella.result, [])];
  }
  const out = [];
  for (const unit of units) {
    if (allowStop && !aborted(deps)) {
      out.push(await stopUnit(deps, origin, unit, unit, log));
    } else {
      out.push(await observeOnly(deps, origin, unit, unit, log));
    }
  }
  return out;
}

async function readPm2(deps, origin) {
  if (!pm2TargetKnown(deps)) return { ok: false, processes: [] };
  const ran = await runObserve(deps, origin, pm2Argv(deps, "jlist"));
  if (ran.kind !== "ok" || ran.code !== 0) return { ok: false, processes: [] };
  let parsed;
  try {
    parsed = JSON.parse(String(ran.stdout ?? ""));
  } catch {
    return { ok: false, processes: [] };
  }
  if (!Array.isArray(parsed)) return { ok: false, processes: [] };
  const processes = [];
  for (const row of parsed) {
    const name = row?.name;
    const pid = Number(row?.pid);
    const status = typeof row?.pm2_env?.status === "string" ? row.pm2_env.status : "";
    const startTime = Number(row?.pm2_env?.startTime);
    if (typeof name !== "string" || !NAME_RE.test(name)) return { ok: false, processes: [] };
    if (!Number.isInteger(pid) || pid < 0) return { ok: false, processes: [] };
    if (!Number.isInteger(startTime) || startTime < 0) return { ok: false, processes: [] };
    // status stopped/stopping with a live pid is still alive. pid 0 is gone.
    // A row that disappears on the next read is also gone.
    processes.push({
      name,
      pid,
      status,
      startTime,
      alive: pid > 0,
    });
  }
  return { ok: true, processes };
}

function pm2Argv(deps, command, name) {
  const tail = name === undefined ? [command] : [command, name];
  if (deps.pm2User === "root") return ["pm2", ...tail];
  return [
    "sudo", "-n", "-u", deps.pm2User, "-H", "env",
    `PM2_HOME=${deps.pm2Home}`, "pm2", ...tail,
  ];
}

async function stopPm2Name(deps, origin, inventory, name, stage, log) {
  if (!NAME_RE.test(name)) {
    log(`stage=${stage} result=unconfirmed`);
    return effect(name, stage, "unconfirmed", []);
  }
  const procs = inventory.processes.filter((proc) => proc.name === name && proc.alive);
  if (procs.length === 0) {
    log(`stage=${stage} name=${name} result=not_applicable`);
    return effect(name, stage, "not_applicable", []);
  }
  const identities = procs.map((proc) => identityOf(deps, proc));
  let ran = await runControl(deps, origin, stage, name, pm2Argv(deps, "stop", name));
  if (ran.kind === "observed") {
    const mid = await readPm2(deps, origin);
    const still = mid.ok && mid.processes.some((proc) => proc.name === name && proc.alive);
    if (!mid.ok) {
      log(`stage=${stage} name=${name} result=unconfirmed`);
      return effect(name, stage, "unconfirmed", identities);
    }
    if (!still) {
      log(`stage=${stage} name=${name} result=stopped`);
      return effect(name, stage, "stopped", identities);
    }
    ran = await runControl(deps, origin, stage, name, pm2Argv(deps, "stop", name));
  }
  if (ran.kind === "skipped" || ran.kind === "aborted" || ran.kind === "unconfirmed") {
    log(`stage=${stage} name=${name} result=unconfirmed`);
    return effect(name, stage, "unconfirmed", identities);
  }
  const gone = await waitGone(deps, origin, name);
  log(`stage=${stage} name=${name} result=${gone}`);
  return effect(name, stage, gone, identities);
}

async function waitGone(deps, origin, name) {
  for (;;) {
    if (aborted(deps) || remainingMs(deps, origin) <= 0) return "unconfirmed";
    const seen = await readPm2(deps, origin);
    if (!seen.ok) return "unconfirmed";
    const live = seen.processes.some((proc) => proc.name === name && proc.alive);
    if (!live) return "stopped";
    const slice = Math.min(deps.pollMs ?? 20, remainingMs(deps, origin));
    if (slice <= 0) return "unconfirmed";
    if (typeof deps.sleep === "function") await deps.sleep(slice);
    else await new Promise((resolve) => setTimeout(resolve, slice));
  }
}

async function runObserve(deps, origin, argv) {
  if (aborted(deps)) return { kind: "aborted" };
  const timeoutMs = remainingMs(deps, origin);
  if (timeoutMs <= 0) return { kind: "skipped" };
  try {
    return await waitFor(deps, deps.exec(argv, { timeoutMs, signal: deps.signal }), timeoutMs);
  } catch {
    return { kind: "unconfirmed" };
  }
}

async function runControl(deps, origin, stage, name, argv) {
  if (aborted(deps)) return { kind: "aborted" };
  const timeoutMs = remainingMs(deps, origin);
  if (timeoutMs <= 0) return { kind: "skipped" };
  // A control command already in flight is waited, never joined by a second one.
  if (deps.control?.inflight) {
    const waited = await waitFor(deps, deps.control.inflight, timeoutMs);
    if (waited.kind !== "ok") return { kind: "unconfirmed" };
    if (deps.control) deps.control.inflight = null;
    return { kind: "observed" };
  }
  try {
    await deps.persist({
      v: 1,
      requestId: deps.requestId,
      stage,
      name,
    });
  } catch {
    return { kind: "unconfirmed" };
  }
  if (aborted(deps)) return { kind: "aborted" };
  let task;
  try {
    task = deps.exec(argv, { timeoutMs: remainingMs(deps, origin), signal: deps.signal });
  } catch {
    return { kind: "unconfirmed" };
  }
  if (deps.control) deps.control.inflight = task;
  const waited = await waitFor(deps, task, remainingMs(deps, origin));
  if (waited.kind === "ok" && deps.control?.inflight === task) deps.control.inflight = null;
  return waited;
}

async function waitFor(deps, task, timeoutMs) {
  let settled = false;
  let value;
  let failed = false;
  const pending = Promise.resolve(task).then(
    (next) => {
      settled = true;
      value = next;
    },
    () => {
      settled = true;
      failed = true;
    },
  );
  const step = Math.max(1, Math.min(deps.pollMs ?? 20, timeoutMs || 1));
  let waited = 0;
  while (!settled && waited < timeoutMs && !aborted(deps)) {
    await Promise.race([pending, Promise.resolve()]);
    if (settled || failed) break;
    if (typeof deps.sleep === "function") await deps.sleep(step);
    else await new Promise((resolve) => setTimeout(resolve, step));
    waited += step;
  }
  if (failed) return { kind: "unconfirmed" };
  if (settled) return { kind: "ok", code: value?.code ?? 0, stdout: value?.stdout ?? "" };
  if (aborted(deps)) return { kind: "aborted" };
  return { kind: "unconfirmed" };
}
