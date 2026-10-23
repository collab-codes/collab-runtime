// Ordered stop of managed services. Commands, clock and observation are injected.
// This module never stops the host by itself and never builds a shell from data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { procIdentity, startTimeFromStat, uidFromStatus } from "../scripts/pm2-lifecycle.mjs";
import { listPm2 } from "../scripts/pm2-readonly.mjs";
import { isPm2Module, runPm2StopOrder } from "../scripts/pm2-stop-order.mjs";

const PHASE_STAGE = Object.freeze({ apps: "pm2-apps", "msg-worker": "msg-worker", msg: "msg" });
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
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
 * @param {(path: string) => string} [deps.readProc] /proc reader; ENOENT means gone
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

  const pm2Bin = pm2TargetKnown(deps) ? await resolvePm2Bin(deps, origin) : "";
  const pm2Effects = await stopPm2InOrder(deps, origin, pm2Bin, log);
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
  ]);
  if (ran.kind !== "ok" || ran.code !== 0) return { result: "unconfirmed" };
  const parsed = parseShow(ran.stdout);
  if (parsed.LoadState === "not-found") return { result: "not_applicable" };
  if (unitQuiet(parsed)) return { result: "stopped" };
  return { result: "running" };
}

// `systemctl show -p` prints KEY=VALUE in systemd's own order, not in the
// order of the -p flags, so the value is read by key.
function parseShow(stdout) {
  const props = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    LoadState: props.LoadState ?? "",
    ActiveState: props.ActiveState ?? "",
    SubState: props.SubState ?? "",
    MainPID: props.MainPID ?? "",
    TasksCurrent: props.TasksCurrent ?? "",
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

// Installed copies rewrite this import to /usr/local/lib/collab/pm2-readonly.mjs.
function adapterScript() {
  if (typeof listPm2 !== "function") throw new TypeError("pm2-readonly");
  const self = fileURLToPath(import.meta.url);
  const matched = readFileSync(self, "utf8").match(/from "([^"]+pm2-readonly\.mjs)"/);
  if (!matched) throw new TypeError("pm2-readonly-import");
  const spec = matched[1];
  if (spec.startsWith("/")) return spec;
  return fileURLToPath(new URL(spec, import.meta.url));
}

function asUser(deps, argv) {
  if (deps.pm2User === "root") return ["env", `PM2_HOME=${deps.pm2Home}`, ...argv];
  return ["sudo", "-n", "-u", deps.pm2User, "-H", "env", `PM2_HOME=${deps.pm2Home}`, ...argv];
}

async function resolvePm2Bin(deps, origin) {
  if (typeof deps.pm2Bin === "string" && deps.pm2Bin.startsWith("/")) return deps.pm2Bin;
  const ran = await runObserve(deps, origin, asUser(deps, ["which", "pm2"]));
  if (ran.kind !== "ok" || ran.code !== 0) return "";
  const line = String(ran.stdout ?? "").trim().split("\n")[0];
  return line.startsWith("/") ? line : "";
}

async function readPm2(deps, origin, pm2Bin) {
  if (!pm2TargetKnown(deps) || !pm2Bin) return { ok: false, processes: [] };
  const ran = await runObserve(deps, origin, asUser(deps, [process.execPath, adapterScript(), "list", pm2Bin]));
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
    // pm_uptime is only validated here; the identity start time is read from /proc.
    const startTime = Number(row?.pm2_env?.pm_uptime);
    if (typeof name !== "string" || !NAME_RE.test(name)) return { ok: false, processes: [] };
    if (!Number.isInteger(pid) || pid < 0) return { ok: false, processes: [] };
    if (!Number.isInteger(startTime) || startTime < 0) return { ok: false, processes: [] };
    // status stopped/stopping with a live pid is still alive. pid 0 is gone.
    // A row that disappears on the next read is also gone.
    processes.push({
      name,
      pid,
      pm_id: row?.pm_id,
      status,
      pmxModule: isPm2Module(row),
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

// pm2 reads "all" and an all-digit argument as every process or a pm_id, never as one app name.
function stoppableName(name) {
  return NAME_RE.test(name) && name !== "all" && !/^[0-9]+$/.test(name);
}

function errorText(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

/** File text, or null when the path is gone (ENOENT). Any other failure is thrown. */
function readProcOptional(deps, path) {
  try {
    return typeof deps.readProc === "function" ? deps.readProc(path) : readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Kernel identity of a pid, or null when the process is gone. */
function kernelOf(deps, pid) {
  const stat = readProcOptional(deps, `/proc/${pid}/stat`);
  if (stat === null) return null;
  const status = readProcOptional(deps, `/proc/${pid}/status`);
  if (status === null) return null;
  return { startTime: startTimeFromStat(stat), uid: uidFromStatus(status) };
}

function readBootId(deps) {
  const text = readProcOptional(deps, BOOT_ID_PATH);
  const bootId = String(text ?? "").trim();
  if (bootId === "") throw new Error("boot_id");
  return bootId;
}

/**
 * apps -> msg-worker -> msg through the shared order (scripts/pm2-stop-order.mjs). Each phase is
 * confirmed by kernel identity (boot_id, pid, /proc start time, uid): a row that leaves the list
 * while its pid lives is still alive, a reused pid is not the old process, and a new instance of
 * the phase name keeps the phase open. A phase not confirmed leaves its dependents without a stop.
 */
async function stopPm2InOrder(deps, origin, pm2Bin, log) {
  const inventoryFailed = () => {
    log("stage=pm2-inventory result=unconfirmed");
    return [effect("pm2", "pm2-inventory", "unconfirmed", [])];
  };
  const inventory = await readPm2(deps, origin, pm2Bin);
  if (!inventory.ok) return inventoryFailed();

  let bootId;
  /** @type {Map<number, { name: string, startTime: number, uid: number }>} */
  const original = new Map();
  const rows = [];
  try {
    bootId = readBootId(deps);
    for (const proc of inventory.processes) {
      if (proc.pmxModule) {
        rows.push({ name: proc.name, pid: proc.pid, pmxModule: true });
        continue;
      }
      if (!proc.alive) continue;
      const kernel = kernelOf(deps, proc.pid);
      if (!kernel) {
        log(`stage=pm2-inventory name=${proc.name} pid=${proc.pid} result=absent`);
        continue;
      }
      original.set(proc.pid, { name: proc.name, startTime: kernel.startTime, uid: kernel.uid });
      rows.push({ name: proc.name, pm_id: proc.pm_id, pid: proc.pid, startTime: kernel.startTime });
    }
  } catch (error) {
    log(`stage=pm2-inventory error=${errorText(error)}`);
    return inventoryFailed();
  }

  /** @type {Map<string, Map<string, object>>} identities seen per name, for the report */
  const seenIds = new Map();
  const remember = (name, pid, startTime) => {
    const id = procIdentity(bootId, pid, startTime);
    if (!seenIds.has(name)) seenIds.set(name, new Map());
    seenIds.get(name).set(`${pid}:${startTime}`, id);
  };
  for (const [pid, entry] of original) remember(entry.name, pid, entry.startTime);

  const observe = async () => {
    const seen = await readPm2(deps, origin, pm2Bin);
    if (!seen.ok) return { ok: false };
    try {
      if (readBootId(deps) !== bootId) throw new Error("boot_id changed");
      const processes = [];
      const counted = new Set();
      for (const [pid, entry] of original) {
        const kernel = kernelOf(deps, pid);
        if (!kernel || kernel.startTime !== entry.startTime) continue;
        if (kernel.uid !== entry.uid) throw new Error(`uid changed pid=${pid}`);
        processes.push({ name: entry.name, pid, startTime: kernel.startTime });
        counted.add(pid);
      }
      for (const proc of seen.processes) {
        if (proc.pmxModule || !proc.alive || counted.has(proc.pid)) continue;
        const kernel = kernelOf(deps, proc.pid);
        if (!kernel) continue;
        remember(proc.name, proc.pid, kernel.startTime);
        processes.push({ name: proc.name, pid: proc.pid, startTime: kernel.startTime });
      }
      return { ok: true, processes };
    } catch (error) {
      log(`stage=pm2-observe error=${errorText(error)}`);
      return { ok: false };
    }
  };

  const stop = async (phase) => {
    const stage = PHASE_STAGE[phase.phase];
    for (const name of phase.names) {
      if (!stoppableName(name)) {
        log(`stage=${stage} name=${name} error=reserved-name`);
        return false;
      }
      const argv = pm2Argv(deps, "stop", name);
      let ran = await runControl(deps, origin, stage, name, argv);
      if (ran.kind === "observed") {
        const mid = await observe();
        if (!mid.ok) return false;
        if (!mid.processes.some((proc) => proc.name === name)) continue;
        ran = await runControl(deps, origin, stage, name, argv);
      }
      if (ran.kind !== "ok") {
        log(`stage=${stage} name=${name} control=${ran.kind}`);
        return false;
      }
      if (ran.code !== 0) log(`stage=${stage} name=${name} code=${ran.code}`);
    }
    return true;
  };

  const result = await runPm2StopOrder({
    inventory: rows,
    remainingMs: remainingMs(deps, origin),
    stop,
    observe,
    now: deps.mono,
    sleep: typeof deps.sleep === "function" ? deps.sleep : undefined,
    pollMs: deps.pollMs ?? 20,
    signal: deps.signal,
    log,
  });

  const identitiesOf = (name) => [...(seenIds.get(name)?.values() ?? [])];
  const out = [];
  for (const phase of result.phases) {
    const stage = PHASE_STAGE[phase.phase];
    if (phase.instances.length === 0) {
      // Absent before the order started: nothing to stop. The apps phase has no single name.
      if (phase.phase !== "apps") out.push(effect(phase.phase, stage, "not_applicable", []));
      continue;
    }
    for (const name of phase.names) {
      if (phase.result === "stopped") {
        out.push(effect(name, stage, "stopped", identitiesOf(name)));
      } else if (phase.result === "blocked") {
        // Not stopped because an earlier phase is not confirmed: still running, so unconfirmed.
        out.push({ ...effect(name, stage, "unconfirmed", identitiesOf(name)), reason: "dependency" });
        log(`stage=${stage} name=${name} result=unconfirmed reason=dependency`);
      } else {
        out.push(effect(name, stage, "unconfirmed", identitiesOf(name)));
      }
    }
  }
  if (!result.ok) return out;

  // A process started outside the phases (or after its phase) must not pass as stopped.
  const last = await observe();
  if (!last.ok) {
    out.push(effect("pm2", "pm2-confirm", "unconfirmed", []));
    log("stage=pm2-confirm result=unconfirmed");
  } else if (last.processes.length === 0) {
    out.push(effect("pm2", "pm2-confirm", "stopped", []));
    log("stage=pm2-confirm result=stopped");
  } else {
    for (const name of new Set(last.processes.map((proc) => proc.name))) {
      out.push(effect(name, "pm2-confirm", "unconfirmed", identitiesOf(name)));
      log(`stage=pm2-confirm name=${name} result=unconfirmed`);
    }
  }
  return out;
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
