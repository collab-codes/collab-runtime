// Retomable shutdown worker. Host commands, clock and HTTP are injected.
// Importing this module does not admit a request, stop services or halt.
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  DEFAULT_ENV_PATH,
  HEARTBEAT_ORIGIN,
  buildHeartbeatBody,
  currentBootId,
  loadConfig,
  sendHeartbeat,
} from "./collab-sites-agent.mjs";
import { stopServices } from "./shutdown-services.mjs";
import {
  FAILSAFE_AFTER_MS,
  admitShutdown,
  parseShutdownArgs,
  readShutdownState,
  receiptOf,
  remainingSelfMs,
  transitionShutdown,
} from "./shutdown-state.mjs";

export const SHUTDOWN_UNIT = "collab-shutdown.service";
export const POWEROFF_ARGV = Object.freeze(["/usr/sbin/shutdown", "-h", "now"]);
export const HEARTBEAT_ATTEMPTS = 3;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const HEARTBEAT_BUDGET_MS = 60_000;
const STOP_CUTOFF_MS = 60_000;
const SKIPPED_NAMES = Object.freeze(["nginx", "msg-worker", "msg", "redis-server", "postgresql"]);

export async function prepare(argv, deps = {}) {
  if (!isRoot(deps)) return receiptOf({ result: "rejected", reason: "not_root" });
  const parsed = parseShutdownArgs(argv);
  if (!parsed.ok) return receiptOf({ result: "rejected", reason: parsed.reason });
  const decision = await admitShutdown(
    { requestId: parsed.requestId, deadlineMs: parsed.deadlineMs },
    stateDeps(deps),
  );
  if (decision.result !== "durable" && decision.result !== "existing") return receiptOf(decision);
  const started = await confirmUnit(deps);
  if (!started.ok) {
    return { result: "start_unconfirmed", requestId: decision.requestId };
  }
  if (decision.result === "existing") return receiptOf(decision);
  return { result: "accepted", requestId: decision.requestId };
}

export async function run(deps = {}) {
  if (!isRoot(deps)) return { result: "rejected", reason: "not_root" };
  const stateDepsOf = stateDeps(deps);
  const loaded = await readShutdownState(stateDepsOf);
  if (loaded.status === "absent") return { result: "absent" };
  if (loaded.status === "invalid") return { result: "invalid", reason: loaded.reason };
  if (loaded.status === "other_boot") {
    return { result: "stale_boot", requestId: loaded.record.requestId };
  }
  let record = loaded.record;
  const plan = failsafePlan(record, deps.mono());
  const armed = await armFailsafe(plan, deps);
  if (!armed.ok && plan.remainingMs > 0) {
    record = await freeze(record, "failed", skippedReport(record, deps), deps);
    const beats = await sendFinal(record, deps);
    const halt = await requestHalt(record, deps);
    return outcome(record, halt, beats, plan);
  }
  if (!record.report) {
    if (record.phase === "requested") {
      const moved = await transitionShutdown({ phase: "stopping" }, stateDepsOf);
      if (moved.record) record = moved.record;
    }
    await sendHealth(deps);
    const budget = remainingSelfMs(record, deps.mono()) - STOP_CUTOFF_MS;
    let observation;
    if (budget <= 0) {
      observation = skippedObservation();
    } else {
      try {
        observation = await (deps.stopServices ?? stopServices)(serviceDeps(record, deps));
      } catch (err) {
        return { result: "kept", requestId: record.requestId, reason: err.message };
      }
    }
    const phase = phaseOf(observation, budget);
    record = await freeze(record, phase, reportFrom(record, deps, observation), deps);
  }
  const beats = await sendFinal(record, deps);
  const halt = await requestHalt(record, deps);
  return outcome(record, halt, beats, plan);
}

export function failsafePlan(record, monoNow) {
  const atMs = Date.parse(record.requestedAt) + FAILSAFE_AFTER_MS;
  const remainingMs = atMs - record.wallAtAdmit - (monoNow - record.monoAtAdmit);
  return {
    atMs,
    remainingMs,
    requestId: record.requestId,
    bootId: record.bootId,
    unit: `collab-shutdown-failsafe-${record.requestId}`,
  };
}

function outcome(record, halt, beats, plan) {
  return {
    result: halt.called ? "halt_requested" : "kept",
    requestId: record.requestId,
    phase: record.phase,
    report: record.report,
    poweroffRequestedAt: halt.poweroffRequestedAt,
    poweroffCode: halt.code,
    heartbeatAttempts: beats,
    failsafeAtMs: plan.atMs,
  };
}

async function confirmUnit(deps) {
  const start = deps.startUnit ?? defaultStartUnit;
  try {
    const result = await start({ unit: SHUTDOWN_UNIT });
    return { ok: Boolean(result && result.ok) };
  } catch {
    return { ok: false };
  }
}

async function armFailsafe(plan, deps) {
  if (plan.remainingMs <= 0) return { ok: true, atMs: plan.atMs, due: true };
  const arm = deps.armFailsafe ?? defaultArmFailsafe;
  try {
    const existing = deps.readFailsafe ? await deps.readFailsafe(plan) : null;
    if (existing && existing.atMs === plan.atMs) return { ok: true, atMs: plan.atMs, kept: true };
    if (existing && existing.atMs > plan.atMs) {
      return { ok: false, reason: "failsafe_later" };
    }
    const result = await arm(plan);
    if (!result || result.ok !== true) return { ok: false, reason: result?.reason || "failsafe_failed" };
    if (result.atMs !== plan.atMs) return { ok: false, reason: "failsafe_moved" };
    return { ok: true, atMs: plan.atMs };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function freeze(record, phase, report, deps) {
  if (record.report) return record;
  const decision = await transitionShutdown({ phase, report }, stateDeps(deps));
  if (!decision.record) {
    const err = new Error(decision.reason || "freeze_failed");
    err.decision = decision;
    throw err;
  }
  return decision.record;
}

function skippedObservation() {
  return { stopped: [], notStopped: SKIPPED_NAMES.slice(), servicesStopped: false };
}

function skippedReport(record, deps) {
  return reportFrom(record, deps, skippedObservation());
}

function reportFrom(record, deps, observation) {
  const startedMs = record.wallAtAdmit;
  const finishedMs = startedMs + Math.max(0, deps.mono() - record.monoAtAdmit);
  return {
    stopped: observation.stopped.slice(),
    notStopped: observation.notStopped.slice(),
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
  };
}

function phaseOf(observation, budget) {
  if (observation.servicesStopped && observation.notStopped.length === 0) return "services_stopped";
  if (budget <= 0) return "deadline_exceeded";
  return "failed";
}

function serviceDeps(record, deps) {
  const pm2 = deps.pm2 ?? {};
  return {
    requestId: record.requestId,
    selfDeadlineAt: Date.parse(record.selfDeadlineAt),
    now: deps.now,
    mono: deps.mono,
    signal: deps.signal,
    pm2User: pm2.user,
    pm2Home: pm2.home,
    bootId: record.bootId,
    persist: (intent) => persistIntent(intent, deps),
    exec: deps.exec,
    sleep: deps.sleep,
    log: deps.log,
  };
}

async function persistIntent(intent, deps) {
  if (deps.crash === "before-intent") {
    throw Object.assign(new Error("crash-before-intent"), { code: "CRASH" });
  }
  if (typeof deps.persist === "function") await deps.persist(intent);
}

async function sendHealth(deps) {
  try {
    const config = await resolveConfig(deps);
    await sendHeartbeat(config, {
      collectFacts: () => factsOf(deps),
      postJson: (url, opts) => postJson(deps, url, opts, "health"),
    });
  } catch {
    // A missed health beat does not delay the stop or the halt.
  }
}

async function sendFinal(record, deps) {
  const snapshot = {
    requestId: record.requestId,
    stopped: record.report.stopped.slice(),
    notStopped: record.report.notStopped.slice(),
    startedAt: record.report.startedAt,
    finishedAt: record.report.finishedAt,
  };
  let config;
  try {
    config = await resolveConfig(deps);
  } catch {
    return 0;
  }
  const base = buildHeartbeatBody(config, factsOf(deps));
  const body = {
    ...base,
    status: "shutdown_ready",
    payload: { ...base.payload, shutdown: snapshot },
  };
  const origin = deps.mono();
  let attempts = 0;
  while (attempts < HEARTBEAT_ATTEMPTS) {
    const left = HEARTBEAT_BUDGET_MS - (deps.mono() - origin);
    if (left <= 0) break;
    attempts += 1;
    const timeoutMs = Math.min(HEARTBEAT_TIMEOUT_MS, left);
    try {
      const result = await postJson(
        deps,
        `${config.sitesUrl}/api/v1/servers/${config.serverId}/heartbeat`,
        {
          headers: { "X-Collab-Origin": HEARTBEAT_ORIGIN },
          body,
          timeoutMs,
        },
        "shutdown_ready",
      );
      if (result && result.statusCode >= 200 && result.statusCode < 300) return attempts;
    } catch {
      // The next attempt stays inside the reserved minute.
    }
  }
  return attempts;
}

async function requestHalt(record, deps) {
  const stamp = record.poweroffRequestedAt ?? new Date(deps.now()).toISOString();
  const decision = await transitionShutdown({ poweroffRequestedAt: stamp }, stateDeps(deps));
  if (!decision.record?.poweroffRequestedAt) {
    return { called: false, poweroffRequestedAt: null, code: null };
  }
  const poweroff = deps.poweroff ?? defaultPoweroff;
  try {
    const result = await poweroff(POWEROFF_ARGV.slice());
    return {
      called: true,
      poweroffRequestedAt: decision.record.poweroffRequestedAt,
      code: result?.code ?? 0,
    };
  } catch (err) {
    return {
      called: true,
      poweroffRequestedAt: decision.record.poweroffRequestedAt,
      code: null,
      error: err.message,
    };
  }
}

function factsOf(deps) {
  if (typeof deps.collectFacts === "function") return deps.collectFacts();
  return {
    runtimeStatus: "ok",
    runtimeVersion: "",
    hostname: "",
    loadavg: "",
    disk: "",
    services: {},
    pm2: { dump: "absent", expected: [], processes: [] },
  };
}

async function resolveConfig(deps) {
  if (deps.config) return deps.config;
  return loadConfig(deps.envPath, deps);
}

async function postJson(deps, url, opts, kind) {
  const send = deps.postJson ?? defaultPostJson;
  return send(url, { ...opts, kind });
}

function stateDeps(deps) {
  return {
    stateDir: deps.stateDir,
    bootId: deps.bootId,
    now: deps.now,
    mono: deps.mono,
    fs: deps.fs,
  };
}

function isRoot(deps) {
  const uid = typeof deps.getuid === "function" ? deps.getuid() : process.getuid?.();
  return uid === 0;
}

export function defaultStartUnit() {
  return startUnitWith(runArgv, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/**
 * `systemctl start --no-block` exit 0 only means the job was queued; it can still be refused or fail.
 * Accepted only once the unit is seen activating or active within a short window.
 * @param {(argv: string[], timeoutMs: number) => Promise<{code: number|null, stdout?: string}>} run
 * @param {(ms: number) => Promise<void>} sleep
 */
export async function startUnitWith(run, sleep, attempts = 10, intervalMs = 500) {
  const queued = await run(["systemctl", "start", "--no-block", SHUTDOWN_UNIT], 10_000);
  if (queued.code !== 0) return { ok: false, code: queued.code, reason: "start_refused" };
  for (let i = 0; i < attempts; i += 1) {
    const shown = await run(["systemctl", "show", SHUTDOWN_UNIT, "-p", "ActiveState", "--value"], 5_000);
    const state = String(shown.stdout ?? "").trim();
    if (shown.code === 0 && (state === "activating" || state === "active")) return { ok: true, code: 0, state };
    if (shown.code === 0 && state === "failed") return { ok: false, code: 0, state, reason: "unit_failed" };
    await sleep(intervalMs);
  }
  return { ok: false, code: 0, reason: "unit_not_running" };
}

export function defaultArmFailsafe(plan) {
  const seconds = Math.max(1, Math.ceil(plan.remainingMs / 1000));
  return runArgv([
    "systemd-run",
    "--collect",
    `--unit=${plan.unit}`,
    `--on-active=${seconds}`,
    "--timer-property=AccuracySec=1s",
    ...POWEROFF_ARGV,
  ], 10_000).then((result) => ({
    ok: result.code === 0,
    atMs: plan.atMs,
    code: result.code,
  }));
}

export function defaultPoweroff(argv) {
  return runArgv(argv, 10_000);
}

function defaultPostJson(url, { headers, body, timeoutMs }) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const target = new URL(url);
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(target, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("close", () => clearTimeout(timer));
    req.end(payload);
  });
}

function runArgv(argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, timeout: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/**
 * Adapter for the services module: `exec(argv, { timeoutMs, signal })`.
 * Kills the child on timeout or abort and never rejects.
 */
export function execWith(spawnFn) {
  return (argv, { timeoutMs, signal } = {}) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", aborted: true });
      return;
    }
    const child = spawnFn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let done = false;
    let timer = null;
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, aborted: true });
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, timeout: true });
    }, Math.max(1, Number(timeoutMs) || 10_000));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish({ code: null, stdout }));
    child.on("close", (code) => finish({ code, stdout }));
  });
}

function showProps(stdout) {
  const props = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1);
  }
  return props;
}

/**
 * The business pm2 is the one systemd boots through pm2-start-fixed.sh (rt112).
 * User and PM2_HOME come from the unit; the home cannot be derived from the user.
 * Zero or several such units is `reason`, never a guess.
 */
export async function discoverPm2(run) {
  const listed = await run(
    ["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "pm2-*.service"],
    10_000,
  );
  if (listed.code !== 0) return { reason: "pm2_units_unreadable" };
  const units = String(listed.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => /^pm2-[A-Za-z0-9_.@-]+\.service$/.test(unit));
  const matches = [];
  for (const unit of units) {
    const shown = await run(["systemctl", "show", unit, "-p", "ExecStart", "-p", "User", "-p", "Environment"], 10_000);
    if (shown.code !== 0) return { reason: "pm2_unit_unreadable", unit };
    const props = showProps(shown.stdout);
    if (!String(props.ExecStart ?? "").includes("pm2-start-fixed.sh")) continue;
    const homeEntry = String(props.Environment ?? "").split(/\s+/).find((item) => item.startsWith("PM2_HOME="));
    matches.push({ unit, user: props.User ?? "", home: homeEntry ? homeEntry.slice("PM2_HOME=".length) : "" });
  }
  if (matches.length === 0) return { reason: "pm2_unit_absent" };
  if (matches.length > 1) return { reason: "pm2_unit_ambiguous" };
  const [match] = matches;
  if (!match.user || !match.home) return { reason: "pm2_unit_incomplete", unit: match.unit };
  return { unit: match.unit, user: match.user, home: match.home };
}

/** A restarted worker keeps the timer it armed: same unit name, same request, same atMs. */
export async function readFailsafeWith(run, plan) {
  const shown = await run(["systemctl", "show", `${plan.unit}.timer`, "-p", "ActiveState", "--value"], 5_000);
  if (shown.code === 0 && String(shown.stdout ?? "").trim() === "active") return { atMs: plan.atMs };
  return null;
}

/** Host dependencies of the installed CLI. Tests inject `io`; the CLI passes nothing. */
export async function productionDeps(io = {}) {
  const run = io.run ?? runArgv;
  const log = io.log ?? ((line) => process.stderr.write(`${line}\n`));
  const pm2 = await discoverPm2(run);
  if (pm2.reason) log(`stage=pm2-target result=${pm2.reason}${pm2.unit ? ` unit=${pm2.unit}` : ""}`);
  else log(`stage=pm2-target unit=${pm2.unit} user=${pm2.user} home=${pm2.home}`);
  return {
    bootId: currentBootId(io),
    envPath: DEFAULT_ENV_PATH,
    now: () => Date.now(),
    mono: () => Number(process.hrtime.bigint() / 1000000n),
    exec: execWith(io.spawn ?? spawn),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    pm2: pm2.reason ? {} : { user: pm2.user, home: pm2.home },
    readFailsafe: (plan) => readFailsafeWith(run, plan),
  };
}

function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isCliEntry()) {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== "prepare" && command !== "run") {
    console.error("usage: shutdown-worker.mjs <prepare|run>");
    process.exit(2);
  }
  productionDeps().then((deps) => (command === "prepare" ? prepare(argv, deps) : run(deps))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const halted = result.result === "halt_requested" && result.poweroffCode === 0;
    const ok = result.result === "accepted" || result.result === "existing" || result.result === "stale_boot" || result.result === "absent" || halted;
    process.exit(ok ? 0 : 1);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
