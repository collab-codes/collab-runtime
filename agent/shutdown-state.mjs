import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const SHUTDOWN_DIR = "/var/lib/collab/shutdown";
export const SHUTDOWN_FILE = "current.json";
export const AWS_WINDOW_MS = 60 * 60 * 1000;
export const SELF_BUDGET_MS = 50 * 60 * 1000;
export const FAILSAFE_AFTER_MS = 52 * 60 * 1000;
export const FUTURE_SKEW_MS = 60 * 1000;

const PHASES = new Set([
  "requested",
  "stopping",
  "services_stopped",
  "deadline_exceeded",
  "failed",
]);
const TERMINAL = new Set(["services_stopped", "deadline_exceeded", "failed"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const RECORD_KEYS = new Set([
  "v",
  "requestId",
  "deadline",
  "requestedAt",
  "selfDeadlineAt",
  "bootId",
  "phase",
  "seq",
  "poweroffRequestedAt",
  "report",
  "monoAtAdmit",
  "wallAtAdmit",
]);

function defaultFs() {
  return { chmod, mkdir, open, rename, unlink };
}

function clock(deps) {
  return {
    wall: deps.now ? deps.now() : Date.now(),
    mono: deps.mono ? deps.mono() : Number(process.hrtime.bigint() / 1000000n),
  };
}

export function parseShutdownArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let requestId;
  let deadline;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--request-id") {
      if (requestId !== undefined) return rejectParse("duplicate_arg");
      requestId = args[++i];
      if (requestId === undefined) return rejectParse("missing_arg");
    } else if (arg === "--deadline") {
      if (deadline !== undefined) return rejectParse("duplicate_arg");
      deadline = args[++i];
      if (deadline === undefined) return rejectParse("missing_arg");
    } else {
      return rejectParse("unknown_arg");
    }
  }
  if (requestId === undefined || deadline === undefined) return rejectParse("missing_arg");
  const id = normalizeUuid(requestId);
  if (!id) return rejectParse("bad_uuid");
  const deadlineMs = parseUtc(deadline);
  if (deadlineMs === null) return rejectParse("bad_deadline");
  return { ok: true, requestId: id, deadlineMs };
}

function rejectParse(reason) {
  return { ok: false, reason };
}

function normalizeUuid(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) return null;
  return value.toLowerCase();
}

function parseUtc(value) {
  if (typeof value !== "string" || !value.endsWith("Z")) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

export function deriveInstants(deadlineMs) {
  const requestedAtMs = deadlineMs - AWS_WINDOW_MS;
  return {
    deadline: new Date(deadlineMs).toISOString(),
    requestedAt: new Date(requestedAtMs).toISOString(),
    selfDeadlineAt: new Date(requestedAtMs + SELF_BUDGET_MS).toISOString(),
    failsafeAt: new Date(requestedAtMs + FAILSAFE_AFTER_MS).toISOString(),
  };
}

export function remainingSelfMs(record, monoNow) {
  const budget = Date.parse(record.selfDeadlineAt) - record.wallAtAdmit;
  return budget - (monoNow - record.monoAtAdmit);
}

export async function readShutdownState(deps = {}) {
  const file = statePath(deps);
  const fs = defaultFsJoin(deps);
  let raw;
  try {
    const fh = await fs.open(file, "r");
    try {
      raw = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return { status: "absent" };
    return { status: "invalid", reason: "unreadable" };
  }
  const record = validateRecord(raw);
  if (!record) return { status: "invalid", reason: "malformed" };
  const bootId = deps.bootId ?? "";
  if (!bootId || record.bootId !== bootId) return { status: "other_boot", record };
  return { status: "active", record };
}

export async function admitShutdown(input, deps = {}) {
  const parsed = input.deadlineMs
    ? { ok: true, requestId: normalizeUuid(input.requestId), deadlineMs: input.deadlineMs }
    : parseShutdownArgs(["--request-id", input.requestId, "--deadline", input.deadline]);
  if (!parsed.ok || !parsed.requestId) return decision("rejected", { reason: parsed.reason || "bad_uuid" });
  if (!deps.bootId) return decision("rejected", { reason: "missing_boot" });

  const { wall } = clock(deps);
  const requestedAtMs = parsed.deadlineMs - AWS_WINDOW_MS;
  if (parsed.deadlineMs <= wall) return decision("rejected", { reason: "expired" });
  if (requestedAtMs > wall + FUTURE_SKEW_MS) return decision("rejected", { reason: "future" });

  const current = await readShutdownState(deps);
  if (current.status === "invalid") return decision("invalid_state", { reason: current.reason });
  if (current.status === "active") {
    return decideAgainstActive(current.record, parsed);
  }
  if (current.status === "other_boot" && current.record.requestId === parsed.requestId) {
    return decision("stale_boot", { requestId: parsed.requestId });
  }

  const times = deriveInstants(parsed.deadlineMs);
  const now = clock(deps);
  const record = {
    v: 1,
    requestId: parsed.requestId,
    deadline: times.deadline,
    requestedAt: times.requestedAt,
    selfDeadlineAt: times.selfDeadlineAt,
    bootId: deps.bootId,
    phase: "requested",
    seq: 1,
    poweroffRequestedAt: null,
    report: null,
    monoAtAdmit: now.mono,
    wallAtAdmit: now.wall,
  };
  await persistRecord(record, deps);
  return decision("durable", { requestId: record.requestId, record });
}

function decideAgainstActive(record, parsed) {
  if (record.requestId === parsed.requestId) {
    const sameDeadline = Date.parse(record.deadline) === parsed.deadlineMs;
    if (!sameDeadline) {
      return decision("conflict", { requestId: parsed.requestId, activeRequestId: record.requestId });
    }
    return decision("existing", { requestId: record.requestId, record });
  }
  return decision("busy", { requestId: parsed.requestId, activeRequestId: record.requestId });
}

export async function transitionShutdown(patch, deps = {}) {
  const current = await readShutdownState(deps);
  if (current.status === "absent") return decision("rejected", { reason: "absent" });
  if (current.status === "invalid") return decision("invalid_state", { reason: current.reason });
  if (current.status === "other_boot") {
    return decision("stale_boot", { requestId: current.record.requestId });
  }
  const next = applyPatch(current.record, patch);
  if (next.error) return decision("rejected", { reason: next.error, requestId: current.record.requestId });
  if (next.unchanged) return decision("existing", { requestId: current.record.requestId, record: current.record });
  await persistRecord(next.record, deps);
  return decision("durable", { requestId: next.record.requestId, record: next.record });
}

function applyPatch(record, patch) {
  const phase = patch.phase ?? record.phase;
  if (!PHASES.has(phase)) return { error: "bad_phase" };
  let report = record.report;
  if (patch.report !== undefined) {
    if (record.report) {
      if (!sameReport(record.report, patch.report)) return { error: "report_frozen" };
    } else {
      const checked = validateReport(patch.report);
      if (!checked) return { error: "bad_report" };
      report = checked;
    }
  }
  if (TERMINAL.has(phase) && !report) return { error: "report_required" };
  if (!TERMINAL.has(phase) && report) return { error: "report_early" };
  let poweroffRequestedAt = record.poweroffRequestedAt;
  if (patch.poweroffRequestedAt !== undefined) {
    const ms = parseUtc(patch.poweroffRequestedAt);
    if (ms === null) return { error: "bad_poweroff" };
    const iso = new Date(ms).toISOString();
    if (poweroffRequestedAt && poweroffRequestedAt !== iso) return { error: "poweroff_frozen" };
    poweroffRequestedAt = iso;
  }
  const changed = phase !== record.phase || report !== record.report || poweroffRequestedAt !== record.poweroffRequestedAt;
  if (!changed) return { unchanged: true };
  return {
    record: {
      ...record,
      phase,
      report,
      poweroffRequestedAt,
      seq: record.seq + 1,
    },
  };
}

export function shutdownReportSnapshot(state) {
  if (!state || state.status !== "active" || !state.record?.report) return null;
  const report = state.record.report;
  return {
    requestId: state.record.requestId,
    stopped: report.stopped.slice(),
    notStopped: report.notStopped.slice(),
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
  };
}

export function receiptOf(decision) {
  const out = { result: decision.result };
  if (decision.requestId) out.requestId = decision.requestId;
  if (decision.activeRequestId) out.activeRequestId = decision.activeRequestId;
  if (decision.reason) out.reason = decision.reason;
  return out;
}

function decision(result, fields = {}) {
  return { result, ...fields };
}

async function persistRecord(record, deps) {
  const fs = defaultFsJoin(deps);
  const dir = stateDir(deps);
  const dest = path.join(dir, SHUTDOWN_FILE);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const tmp = path.join(dir, `.${SHUTDOWN_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(canonical(record), "utf8");
    if (deps.crash === "before-fsync") {
      throw Object.assign(new Error("crash-before-fsync"), { code: "CRASH" });
    }
    await fh.sync();
    await fs.chmod(tmp, 0o600);
    if (deps.crash === "before-rename") {
      throw Object.assign(new Error("crash-before-rename"), { code: "CRASH" });
    }
    await fh.close();
    await fs.rename(tmp, dest);
    renamed = true;
    if (deps.crash === "after-rename") {
      throw Object.assign(new Error("crash-after-rename"), { code: "CRASH" });
    }
    const dh = await fs.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch (err) {
    if (!renamed) await fs.unlink(tmp).catch(() => {});
    throw err;
  } finally {
    await fh.close().catch(() => {});
  }
}

function canonical(record) {
  return `${JSON.stringify(record)}\n`;
}

function stateDir(deps) {
  return deps.stateDir || SHUTDOWN_DIR;
}

function statePath(deps) {
  return path.join(stateDir(deps), SHUTDOWN_FILE);
}

function defaultFsJoin(deps) {
  return { ...defaultFs(), ...(deps.fs || {}) };
}

function validateRecord(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) {
    if (!RECORD_KEYS.has(key)) return null;
  }
  if (value.v !== 1) return null;
  const requestId = normalizeUuid(value.requestId);
  if (!requestId) return null;
  const deadlineMs = parseUtc(value.deadline);
  const requestedAtMs = parseUtc(value.requestedAt);
  const selfMs = parseUtc(value.selfDeadlineAt);
  if (deadlineMs === null || requestedAtMs === null || selfMs === null) return null;
  if (requestedAtMs !== deadlineMs - AWS_WINDOW_MS) return null;
  if (selfMs !== requestedAtMs + SELF_BUDGET_MS) return null;
  if (typeof value.bootId !== "string" || value.bootId.length === 0 || value.bootId.length > 128) return null;
  if (!PHASES.has(value.phase)) return null;
  if (!Number.isInteger(value.seq) || value.seq < 1) return null;
  if (!Number.isFinite(value.monoAtAdmit) || !Number.isFinite(value.wallAtAdmit)) return null;
  let poweroffRequestedAt = null;
  if (value.poweroffRequestedAt !== null) {
    const ms = parseUtc(value.poweroffRequestedAt);
    if (ms === null) return null;
    poweroffRequestedAt = new Date(ms).toISOString();
  }
  let report = null;
  if (value.report !== null) {
    report = validateReport(value.report);
    if (!report) return null;
  }
  if (TERMINAL.has(value.phase) !== Boolean(report)) return null;
  if (value.deadline !== new Date(deadlineMs).toISOString()) return null;
  return {
    v: 1,
    requestId,
    deadline: new Date(deadlineMs).toISOString(),
    requestedAt: new Date(requestedAtMs).toISOString(),
    selfDeadlineAt: new Date(selfMs).toISOString(),
    bootId: value.bootId,
    phase: value.phase,
    seq: value.seq,
    poweroffRequestedAt,
    report,
    monoAtAdmit: value.monoAtAdmit,
    wallAtAdmit: value.wallAtAdmit,
  };
}

function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const keys = Object.keys(report);
  if (keys.length !== 4) return null;
  for (const key of keys) {
    if (!["stopped", "notStopped", "startedAt", "finishedAt"].includes(key)) return null;
  }
  const stopped = names(report.stopped);
  const notStopped = names(report.notStopped);
  const started = parseUtc(report.startedAt);
  const finished = parseUtc(report.finishedAt);
  if (!stopped || !notStopped || started === null || finished === null || finished < started) return null;
  return {
    stopped,
    notStopped,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
  };
}

function names(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || !NAME_RE.test(item)) return null;
    out.push(item);
  }
  return out;
}

function sameReport(a, b) {
  const checked = validateReport(b);
  if (!checked) return false;
  return JSON.stringify(a) === JSON.stringify(checked);
}
