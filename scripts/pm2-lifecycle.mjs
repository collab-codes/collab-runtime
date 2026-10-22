#!/usr/bin/env node
// Stop and guard for one PM2_HOME. Observation is separate from kill/start.
// A missing socket, a stopped receipt, or CLI exit 0 is not proof the processes ended.
import { spawn } from "node:child_process";
import { existsSync, openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { listPm2 } from "./pm2-readonly.mjs";

/** Global monotonic budget. Shorter than systemd TimeoutStopSec=900s. */
export const STOP_DEADLINE_MS = 840_000;
const DEFAULT_POLL_MS = 200;
const RECEIPT_NAME = "collab-stop.json";
const LOCK_NAME = "collab-lifecycle.lock";

/**
 * @typedef {object} ProcIdentity
 * @property {string} bootId
 * @property {number} pid
 * @property {number} startTime clock ticks from field 22 of /proc/pid/stat, not a file mtime
 */

/**
 * @typedef {object} StopReceipt
 * @property {string} bootId
 * @property {"stopping"|"stopped"} phase
 * @property {boolean} confirmed
 * @property {ProcIdentity[]} identities
 */

/**
 * @param {string} bootId
 * @param {number} pid
 * @param {number} startTime
 * @returns {ProcIdentity}
 */
export function procIdentity(bootId, pid, startTime) {
  if (typeof bootId !== "string" || bootId.length === 0) {
    throw new TypeError("bootId");
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("pid");
  }
  if (!Number.isInteger(startTime) || startTime < 0) {
    throw new TypeError("startTime");
  }
  return { bootId, pid, startTime };
}

/**
 * @param {string} bootId
 * @param {"stopping"|"stopped"} phase
 * @param {boolean} confirmed
 * @param {ProcIdentity[]} identities
 * @returns {StopReceipt}
 */
export function stopReceipt(bootId, phase, confirmed, identities) {
  if (phase !== "stopping" && phase !== "stopped") {
    throw new TypeError("phase");
  }
  if (typeof confirmed !== "boolean") {
    throw new TypeError("confirmed");
  }
  return {
    bootId,
    phase,
    confirmed,
    identities: identities.map((id) => procIdentity(id.bootId, id.pid, id.startTime)),
  };
}

/**
 * comm is inside parentheses and may itself contain spaces and parentheses.
 * starttime is the 20th whitespace field after the last ")".
 * @param {string} statText
 * @returns {number}
 */
export function startTimeFromStat(statText) {
  const close = statText.lastIndexOf(")");
  if (close < 0 || statText.indexOf("(") < 0) {
    throw new Error("proc stat");
  }
  const fields = statText.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20) {
    throw new Error("proc stat");
  }
  const startTime = Number(fields[19]);
  if (!Number.isInteger(startTime) || startTime < 0) {
    throw new Error("proc stat");
  }
  return startTime;
}

/**
 * @param {string} statusText
 * @returns {number}
 */
export function uidFromStatus(statusText) {
  const line = statusText.split("\n").find((row) => row.startsWith("Uid:"));
  if (!line) {
    throw new Error("proc status");
  }
  const uid = Number(line.split(/\s+/)[1]);
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("proc status");
  }
  return uid;
}

/**
 * Read one variable and drop the block. Never log or store the raw environ.
 * @param {string} raw
 * @param {string} key
 * @returns {string|undefined}
 */
function envValue(raw, key) {
  const prefix = `${key}=`;
  for (const part of raw.split("\0")) {
    if (part.startsWith(prefix)) {
      return part.slice(prefix.length);
    }
  }
  return undefined;
}

/**
 * @param {string} raw
 * @param {string} pm2Home
 * @param {string} home
 * @returns {boolean}
 */
export function environMatchesHome(raw, pm2Home, home) {
  const seenHome = envValue(raw, "PM2_HOME");
  if (seenHome !== undefined) {
    return seenHome === pm2Home;
  }
  const seen = envValue(raw, "HOME");
  return seen !== undefined && seen === home;
}

function identityKey(id) {
  return `${id.bootId}:${id.pid}:${id.startTime}`;
}

function sameIdentity(a, b) {
  return a.bootId === b.bootId && a.pid === b.pid && a.startTime === b.startTime;
}

class ObsError extends Error {
  /**
   * @param {"permission"|"inconsistent"|"unconfirmed"} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function asObsError(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return new ObsError("permission", "permission denied");
  }
  if (error instanceof ObsError) {
    return error;
  }
  return new ObsError("inconsistent", "inventory inconsistent");
}

/**
 * @param {object} io
 * @param {string} file
 * @returns {string|null} null when the path does not exist
 */
function readOptional(io, file) {
  try {
    return String(io.readFile(file));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {object} target
 * @param {object} target.io
 * @param {string} target.pm2Home
 * @param {string} target.unitCgroup
 * @param {number} target.uid
 * @param {string} target.home
 * @param {number[]} [target.excludePids]
 * @param {boolean} includeJlist
 */
export async function observeTarget(target, includeJlist) {
  const { io, pm2Home, unitCgroup, uid, home } = target;
  if (!unitCgroup || unitCgroup === "/") {
    throw new ObsError("inconsistent", "unit cgroup missing");
  }
  const exclude = new Set(target.excludePids || []);
  let bootIdRaw;
  try {
    bootIdRaw = io.readFile("/proc/sys/kernel/random/boot_id");
  } catch (error) {
    throw asObsError(error);
  }
  const bootId = String(bootIdRaw).trim();
  if (!bootId) {
    throw new ObsError("inconsistent", "boot id missing");
  }

  const daemonPid = readDaemonPid(io, pm2Home);
  let daemon = null;
  /** @type {number[]|null} */
  let scanned = null;
  if (daemonPid !== null) {
    daemon = readLiveIdentity(io, daemonPid, bootId, uid, home, pm2Home);
  } else if (typeof io.listProcPids === "function") {
    const scan = scanSameHome(io, uid, home, pm2Home);
    if (!scan.complete) {
      throw new ObsError("unconfirmed", "proc scan");
    }
    scanned = scan.pids;
  }

  let rpc = false;
  try {
    rpc = io.exists(path.join(pm2Home, "rpc.sock"));
  } catch (error) {
    throw asObsError(error);
  }

  /** @type {number[]} */
  let cgroupPids;
  try {
    cgroupPids = io.listCgroupPids(unitCgroup);
  } catch (error) {
    throw asObsError(error);
  }
  if (!Array.isArray(cgroupPids) || cgroupPids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new ObsError("inconsistent", "cgroup inventory");
  }

  /** @type {Set<number>} */
  const wanted = new Set();
  for (const pid of cgroupPids) {
    if (!exclude.has(pid)) {
      wanted.add(pid);
    }
  }
  if (daemon) {
    wanted.add(daemon.pid);
  }
  if (scanned) {
    for (const pid of scanned) {
      if (!exclude.has(pid)) {
        wanted.add(pid);
      }
    }
  }

  if (includeJlist && daemon && rpc) {
    let listed;
    try {
      listed = await listedPids(io, pm2Home, target.pm2Bin);
    } catch (error) {
      throw asObsError(error);
    }
    if (!Array.isArray(listed)) {
      throw new ObsError("inconsistent", "jlist");
    }
    for (const pid of listed) {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new ObsError("inconsistent", "jlist");
      }
      if (!exclude.has(pid)) {
        wanted.add(pid);
      }
    }
  }

  /** @type {ProcIdentity[]} */
  const service = [];
  for (const pid of wanted) {
    const live = readLiveIdentity(io, pid, bootId, uid, home, pm2Home);
    if (live) {
      service.push(live);
    }
  }
  service.sort((a, b) => a.pid - b.pid);

  return {
    bootId,
    daemon,
    rpc,
    service,
  };
}

/**
 * @param {object} io
 * @param {string} pm2Home
 * @returns {number|null}
 */
function readDaemonPid(io, pm2Home) {
  let text;
  try {
    text = readOptional(io, path.join(pm2Home, "pm2.pid"));
  } catch (error) {
    throw asObsError(error);
  }
  if (text === null) {
    return null;
  }
  const pid = Number(String(text).trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ObsError("inconsistent", "pm2.pid");
  }
  return pid;
}

/**
 * Same uid and the real PM2_HOME. A name match is not an identity.
 * Incomplete (unreadable /proc, or a pid we cannot classify) is not an empty result.
 * @returns {{ complete: boolean, pids: number[] }}
 */
function scanSameHome(io, uid, home, pm2Home) {
  let pids;
  try {
    pids = io.listProcPids();
  } catch (error) {
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw asObsError(error);
    }
    return { complete: false, pids: [] };
  }
  if (!Array.isArray(pids)) {
    return { complete: false, pids: [] };
  }
  /** @type {number[]} */
  const matched = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { complete: false, pids: [] };
    }
    // stat and status are world-readable; environ of another uid is not (EACCES on /proc/1 as a deploy user).
    // So the uid filter comes first and environ is read only for our own processes.
    let statText;
    let statusText;
    try {
      statText = readOptional(io, `/proc/${pid}/stat`);
      if (statText === null) {
        continue;
      }
      statusText = readOptional(io, `/proc/${pid}/status`);
      if (statusText === null) {
        continue;
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      if (error && (error.code === "EACCES" || error.code === "EPERM")) {
        throw asObsError(error);
      }
      return { complete: false, pids: [] };
    }
    let seenUid;
    try {
      seenUid = uidFromStatus(statusText);
      startTimeFromStat(statText);
    } catch {
      return { complete: false, pids: [] };
    }
    if (seenUid !== uid) {
      continue;
    }
    let environ;
    try {
      environ = readOptional(io, `/proc/${pid}/environ`);
      if (environ === null) {
        continue;
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      if (error && (error.code === "EACCES" || error.code === "EPERM")) {
        // Our own uid and still unreadable: fail closed, as before.
        throw asObsError(error);
      }
      return { complete: false, pids: [] };
    }
    let sameHome = false;
    try {
      sameHome = sameRealPm2Home(io, environ, pm2Home, home);
    } catch {
      return { complete: false, pids: [] };
    }
    if (!sameHome) {
      continue;
    }
    matched.push(pid);
  }
  return { complete: true, pids: matched };
}

/**
 * @param {string} raw
 * @param {string} pm2Home
 * @param {string} home
 * @returns {boolean}
 */
function sameRealPm2Home(io, raw, pm2Home, home) {
  const seen = envValue(raw, "PM2_HOME");
  if (seen === undefined || typeof io.realpath !== "function") {
    return environMatchesHome(raw, pm2Home, home);
  }
  try {
    return io.realpath(seen) === io.realpath(pm2Home);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Injected `io.jlist` stays the test seam. Production lists through the passive adapter.
 * @returns {Promise<number[]>}
 */
async function listedPids(io, pm2Home, pm2Bin) {
  if (typeof io.jlist === "function") {
    return io.jlist(pm2Home, pm2Bin);
  }
  const rows = await listPm2({ pm2Bin, pm2Home });
  return pidsFromJlist(rows);
}

/**
 * @returns {ProcIdentity|null} null when the pid is gone or its start time changed under us
 */
function readLiveIdentity(io, pid, bootId, uid, home, pm2Home) {
  let statText;
  let statusText;
  let environ;
  try {
    statText = readOptional(io, `/proc/${pid}/stat`);
    if (statText === null) {
      return null;
    }
    statusText = String(io.readFile(`/proc/${pid}/status`));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw asObsError(error);
  }
  let startTime;
  let seenUid;
  try {
    startTime = startTimeFromStat(statText);
    seenUid = uidFromStatus(statusText);
  } catch {
    throw new ObsError("inconsistent", "proc identity");
  }
  // uid first: environ of another uid is unreadable, and the verdict is the same mismatch either way.
  if (seenUid !== uid) {
    throw new ObsError("inconsistent", "uid or home mismatch");
  }
  try {
    environ = String(io.readFile(`/proc/${pid}/environ`));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw asObsError(error);
  }
  if (!sameRealPm2Home(io, environ, pm2Home, home)) {
    throw new ObsError("inconsistent", "uid or home mismatch");
  }
  return procIdentity(bootId, pid, startTime);
}

/**
 * @param {object} io
 * @param {string} pm2Home
 * @param {StopReceipt} receipt
 */
function writeReceipt(io, pm2Home, receipt) {
  const body = JSON.stringify(receipt);
  io.writeAtomic(path.join(pm2Home, RECEIPT_NAME), body, 0o600);
}

/**
 * @param {object} io
 * @param {string} pm2Home
 * @returns {StopReceipt|null}
 */
function readReceipt(io, pm2Home) {
  let raw;
  try {
    raw = readOptional(io, path.join(pm2Home, RECEIPT_NAME));
  } catch (error) {
    throw asObsError(error);
  }
  if (raw === null) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ObsError("inconsistent", "receipt unreadable");
  }
  if (!parsed || (parsed.phase !== "stopping" && parsed.phase !== "stopped") || typeof parsed.confirmed !== "boolean") {
    throw new ObsError("inconsistent", "receipt unreadable");
  }
  if (!Array.isArray(parsed.identities)) {
    throw new ObsError("inconsistent", "receipt unreadable");
  }
  try {
    return stopReceipt(String(parsed.bootId || ""), parsed.phase, parsed.confirmed, parsed.identities);
  } catch {
    throw new ObsError("inconsistent", "receipt unreadable");
  }
}

function logLine(io, text) {
  io.log(`pm2-lifecycle: ${text}`);
}

function receiptFrom(bootId, phase, confirmed, seen) {
  return stopReceipt(bootId, phase, confirmed, [...seen.values()]);
}

/**
 * @param {object} options
 * @returns {Promise<number>}
 */
/**
 * Pids in the unit cgroup that descend from rootPid: the helper's own lock holder (flock, node -e) and the
 * pm2 kill it spawned. They are control, not service processes left behind.
 * @param {object} io
 * @param {string} unitCgroup
 * @param {number} rootPid
 * @returns {number[]}
 */
export function ownDescendants(io, unitCgroup, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 1 || typeof io.listCgroupPids !== "function") {
    return [];
  }
  let pids;
  try {
    pids = io.listCgroupPids(unitCgroup);
  } catch {
    return [];
  }
  const parentOf = (pid) => {
    try {
      const statText = String(io.readFile(`/proc/${pid}/stat`));
      const close = statText.lastIndexOf(")");
      const parent = Number(statText.slice(close + 1).trim().split(/\s+/)[1]);
      return Number.isInteger(parent) ? parent : 0;
    } catch {
      return 0;
    }
  };
  const out = [];
  for (const pid of Array.isArray(pids) ? pids : []) {
    let current = pid;
    for (let hop = 0; hop < 32 && current > 1; hop += 1) {
      const parent = parentOf(current);
      if (parent === rootPid) {
        out.push(pid);
        break;
      }
      if (parent === current || parent <= 1) {
        break;
      }
      current = parent;
    }
  }
  return out;
}

/** Pids excluded from the service inventory: the control chain when known, else the helper itself. */
function controlPidsOf(options) {
  const list = Array.isArray(options.controlPids) && options.controlPids.length > 0 ? options.controlPids : [options.helperPid];
  return list.filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function stopPm2(options) {
  const io = options.io;
  const deadlineMs = options.deadlineMs ?? STOP_DEADLINE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const started = io.now();
  const deadline = started + deadlineMs;
  const exclude = controlPidsOf(options);
  /** @type {Map<string, ProcIdentity>} */
  const seen = new Map();
  /** @type {{ pid: number, finished: Promise<number> }|null} */
  let kill = null;
  /** @type {number|null} */
  let killCode = null;
  let killWait = null;
  let jlistAllowed = true;

  const fail = (receiptBoot, message) => {
    if (receiptBoot) {
      writeReceipt(io, options.pm2Home, receiptFrom(receiptBoot, "stopping", false, seen));
    }
    logLine(io, message);
    return 1;
  };

  while (io.now() <= deadline) {
    /** @type {ReturnType<typeof observeTarget>|null} */
    let obs = null;
    try {
      const descendants = ownDescendants(io, options.unitCgroup, options.helperPid);
      for (const pid of descendants) {
        if (!exclude.includes(pid)) {
          exclude.push(pid);
        }
      }
      obs = await observeTarget({ ...options, excludePids: exclude.filter((pid) => Number.isInteger(pid) && pid > 0) }, jlistAllowed);
    } catch (error) {
      const wrapped = asObsError(error);
      const boot = seen.size > 0 ? [...seen.values()][0].bootId : null;
      return fail(boot, `error=${wrapped.kind}`);
    }

    for (const id of obs.service) {
      const key = identityKey(id);
      if (!seen.has(key)) {
        logLine(io, `phase=stopping pid=${id.pid}`);
      }
      seen.set(key, id);
    }
    writeReceipt(io, options.pm2Home, receiptFrom(obs.bootId, "stopping", false, seen));

    if (obs.daemon && !obs.rpc && kill === null) {
      logLine(io, `error=daemon-without-rpc pid=${obs.daemon.pid}`);
      return 1;
    }

    if (obs.daemon && obs.rpc && kill === null && jlistAllowed) {
      kill = io.spawnKill(options.pm2Bin, options.pm2Home);
      if (!kill || !Number.isInteger(kill.pid) || kill.pid <= 0) {
        return fail(obs.bootId, "error=cli");
      }
      exclude.push(kill.pid);
      killWait = kill.finished.then((code) => {
        killCode = Number.isInteger(code) ? code : 1;
        return killCode;
      });
    }
    if (!obs.rpc) {
      jlistAllowed = false;
    }

    if (killWait) {
      await Promise.race([killWait, Promise.resolve(null)]);
    }

    const alive = obs.service.filter((id) => !exclude.includes(id.pid));
    const commandDone = kill === null || killCode !== null;
    const commandOk = kill === null || killCode === 0;
    if (commandDone && commandOk && alive.length === 0 && !obs.daemon) {
      const prior = [...seen.values()];
      let still = [];
      try {
        still = prior.filter((id) => aliveIdentity(io, id, options));
      } catch (error) {
        return fail(obs.bootId, `error=${asObsError(error).kind}`);
      }
      if (still.length === 0) {
        writeReceipt(io, options.pm2Home, stopReceipt(obs.bootId, "stopped", true, prior));
        logLine(io, "phase=stopped");
        return 0;
      }
    }
    if (commandDone && killCode !== null && killCode !== 0) {
      logLine(io, `error=cli code=${killCode}`);
      writeReceipt(io, options.pm2Home, receiptFrom(obs.bootId, "stopping", false, seen));
      return 1;
    }
    if (io.now() >= deadline) {
      break;
    }
    const slice = Math.min(pollMs, deadline - io.now());
    if (slice <= 0) {
      break;
    }
    await io.sleep(slice);
  }

  let boot = "unknown";
  try {
    boot = String(io.readFile("/proc/sys/kernel/random/boot_id")).trim() || boot;
  } catch {
    boot = seen.size > 0 ? [...seen.values()][0].bootId : boot;
  }
  writeReceipt(io, options.pm2Home, receiptFrom(boot, "stopping", false, seen));
  logLine(io, "error=timeout");
  return 1;
}

function aliveIdentity(io, id, options) {
  try {
    const live = readLiveIdentity(io, id.pid, id.bootId, options.uid, options.home, options.pm2Home);
    return live !== null && sameIdentity(live, id);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * PM2_HOME must be a directory owned by the unit user. The lock file is only
 * collab-lifecycle.lock; a symlink, socket, or pidfile is refused.
 * @param {string} pm2Home
 * @param {number} uid
 * @returns {{ pm2Home: string, lockPath: string }}
 */
export function validatePm2Home(pm2Home, uid) {
  if (typeof pm2Home !== "string" || pm2Home.length === 0 || pm2Home.includes("\0")) {
    throw new ObsError("inconsistent", "PM2_HOME missing");
  }
  if (!Number.isInteger(uid) || uid < 0) {
    throw new ObsError("permission", "uid");
  }
  let listed;
  try {
    listed = lstatSync(pm2Home);
  } catch (error) {
    throw asObsError(error);
  }
  if (!listed.isDirectory()) {
    throw new ObsError("inconsistent", "PM2_HOME");
  }
  if (listed.uid !== uid) {
    throw new ObsError("permission", "PM2_HOME owner");
  }
  const homeReal = realpathSync(pm2Home);
  const lockPath = path.join(homeReal, LOCK_NAME);
  const homePrefix = homeReal.endsWith(path.sep) ? homeReal : `${homeReal}${path.sep}`;
  if (!lockPath.startsWith(homePrefix)) {
    throw new ObsError("inconsistent", "lock path");
  }
  let lockStat = null;
  try {
    lockStat = lstatSync(lockPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw asObsError(error);
    }
  }
  if (lockStat) {
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
      throw new ObsError("inconsistent", "lock path");
    }
    if (lockStat.uid !== uid) {
      throw new ObsError("permission", "lock owner");
    }
    const lockReal = realpathSync(lockPath);
    if (!lockReal.startsWith(homePrefix)) {
      throw new ObsError("inconsistent", "lock path");
    }
  }
  return { pm2Home: homeReal, lockPath };
}

/**
 * Create the lock file as the unit user. Does not chown and does not replace
 * an existing inode (a live socket must never be unlinked).
 * @param {string} lockPath
 * @param {number} uid
 */
export function ensureLockFile(lockPath, uid) {
  let current = null;
  try {
    current = lstatSync(lockPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw asObsError(error);
    }
  }
  if (!current) {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw asObsError(error);
      }
    }
    if (fd !== undefined) {
      closeSync(fd);
    }
    current = lstatSync(lockPath);
  }
  if (current.isSymbolicLink() || !current.isFile() || current.uid !== uid) {
    throw new ObsError("permission", "lock owner");
  }
  if ((current.mode & 0o077) !== 0) {
    chmodSync(lockPath, 0o600);
  }
}

/**
 * Hold an exclusive flock for the remaining global budget. `acquire` resolves
 * to null when the wait expires. The callback receives the leftover budget.
 * @param {object} options
 * @param {(remainMs: number) => Promise<number>} fn
 * @returns {Promise<number>}
 */
export async function withLifecycleLock(options, fn) {
  const io = options.io;
  const started = io.now();
  const budget = options.deadlineMs ?? STOP_DEADLINE_MS;
  let home;
  try {
    home = validatePm2Home(options.pm2Home, options.uid);
    ensureLockFile(home.lockPath, options.uid);
  } catch (error) {
    logLine(io, `error=${asObsError(error).kind}`);
    return 1;
  }
  const waitMs = budget - (io.now() - started);
  if (waitMs <= 0) {
    logLine(io, "error=timeout");
    return 1;
  }
  const release = await options.acquire(home.lockPath, waitMs);
  if (!release) {
    logLine(io, "error=timeout");
    return 1;
  }
  try {
    const remain = budget - (io.now() - started);
    if (remain <= 0) {
      logLine(io, "error=timeout");
      return 1;
    }
    return await fn(remain);
  } finally {
    await release();
  }
}

/**
 * Block until `flock` holds `lockPath`, then resolve a release function.
 * Resolves to null on timeout or when flock is missing. Never deletes the file.
 * @param {string} lockPath
 * @param {number} waitMs
 * @returns {Promise<null|(() => Promise<void>)>}
 */
export function acquireFlock(lockPath, waitMs) {
  const seconds = Math.floor(waitMs / 1000);
  if (seconds <= 0) {
    return Promise.resolve(null);
  }
  const child = spawn("flock", [
    "-w",
    String(seconds),
    "--",
    lockPath,
    process.execPath,
    "-e",
    "const fs=require('node:fs'); fs.writeSync(1,'ok\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("ok\n")) {
        finish(async () => {
          child.stdin.end();
          await new Promise((done) => {
            child.once("exit", () => done());
          });
        });
      }
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
  });
}

/**
 * Refuse start until the previous generation is gone. Does not call PM2.
 * @param {object} options
 * @returns {Promise<number>}
 */
export async function guardPm2(options) {
  const io = options.io;
  let receipt;
  let obs;
  try {
    receipt = readReceipt(io, options.pm2Home);
    obs = await observeTarget({ ...options, excludePids: [...controlPidsOf(options), ...ownDescendants(io, options.unitCgroup, options.helperPid)] }, false);
  } catch (error) {
    const wrapped = asObsError(error);
    logLine(io, `guard refused error=${wrapped.kind}`);
    return 1;
  }

  if (obs.daemon) {
    logLine(io, `guard refused pid=${obs.daemon.pid}`);
    return 1;
  }
  const aliveNow = obs.service.filter((id) => id.pid !== options.helperPid);
  if (aliveNow.length > 0) {
    logLine(io, `guard refused pid=${aliveNow[0].pid}`);
    return 1;
  }

  if (receipt) {
    for (const id of receipt.identities) {
      if (id.bootId !== obs.bootId) {
        continue;
      }
      let live = null;
      try {
        live = readLiveIdentity(io, id.pid, obs.bootId, options.uid, options.home, options.pm2Home);
      } catch (error) {
        logLine(io, `guard refused error=${asObsError(error).kind}`);
        return 1;
      }
      if (live && live.pid === id.pid && live.startTime === id.startTime) {
        logLine(io, `guard refused pid=${id.pid}`);
        return 1;
      }
    }
    if (!receipt.confirmed || receipt.phase !== "stopped") {
      writeReceipt(io, options.pm2Home, stopReceipt(obs.bootId, "stopped", true, receipt.identities));
    }
  }

  logLine(io, "phase=stopped");
  return 0;
}

/**
 * ExecStopPost. Kernel check only: no pm2 kill, jlist, or start.
 * A start timeout is not a graceful drain. An unconfirmed receipt stays unconfirmed.
 * @param {object} options
 * @returns {Promise<number>}
 */
export async function verifyPostStop(options) {
  const io = options.io;
  const serviceResult = String(options.serviceResult || "");
  const exitCode = String(options.exitCode || "");
  const exitStatus = String(options.exitStatus || "");
  logLine(io, `post-stop result=${serviceResult} exit=${exitCode}/${exitStatus}`);
  const exclude = [...controlPidsOf(options), ...ownDescendants(io, options.unitCgroup, options.helperPid)];
  let obs;
  try {
    obs = await observeTarget({ ...options, excludePids: exclude }, false);
  } catch (error) {
    logLine(io, `post-stop unconfirmed error=${asObsError(error).kind}`);
    return 1;
  }
  const alive = obs.service.filter((id) => !exclude.includes(id.pid) && id.pid !== options.helperPid);
  if (obs.daemon || alive.length > 0) {
    const pid = obs.daemon ? obs.daemon.pid : alive[0].pid;
    logLine(io, `post-stop remaining pid=${pid}`);
    return 1;
  }
  if (typeof io.listProcPids !== "function") {
    logLine(io, "post-stop unconfirmed");
    return 1;
  }
  if (serviceResult === "timeout") {
    logLine(io, "post-stop startup-timeout");
  }
  const removed = removeStalePm2Artifacts(io, options.pm2Home, options.uid);
  if (removed === "refused") {
    logLine(io, "post-stop artifacts left");
    return 1;
  }
  logLine(io, removed === "removed" ? "post-stop artifacts cleared" : "post-stop clear");
  return 0;
}

/**
 * Drop a stale pidfile or socket only when the home owner and real path check out.
 * Never follow a symlink. Doubt leaves the inode in place.
 * @returns {"absent"|"removed"|"refused"}
 */
function removeStalePm2Artifacts(io, pm2Home, uid) {
  if (typeof io.lstat !== "function" || typeof io.realpath !== "function" || typeof io.unlink !== "function") {
    return "refused";
  }
  let homeStat;
  let homeReal;
  try {
    homeStat = io.lstat(pm2Home);
    if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.uid !== uid) {
      return "refused";
    }
    homeReal = io.realpath(pm2Home);
  } catch {
    return "refused";
  }
  const prefix = homeReal.endsWith(path.sep) ? homeReal : `${homeReal}${path.sep}`;
  /** @type {string[]} */
  const drop = [];
  for (const [name, kind] of [["pm2.pid", "file"], ["rpc.sock", "socket"]]) {
    const file = path.join(homeReal, name);
    if (!file.startsWith(prefix)) {
      return "refused";
    }
    let st;
    try {
      st = io.lstat(file);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      return "refused";
    }
    if (st.isSymbolicLink()) {
      return "refused";
    }
    if (kind === "file" && !st.isFile()) {
      return "refused";
    }
    if (kind === "socket" && !st.isSocket()) {
      return "refused";
    }
    if (st.uid !== uid) {
      return "refused";
    }
    drop.push(file);
  }
  if (drop.length === 0) {
    return "absent";
  }
  try {
    for (const file of drop) {
      io.unlink(file);
    }
  } catch {
    return "refused";
  }
  return "removed";
}

function ownUnitCgroup(io) {
  const text = io.readFile("/proc/self/cgroup");
  const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
  let rel = "";
  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length >= 3 && parts[0] === "0" && parts[1] === "") {
      rel = parts.slice(2).join(":");
    }
  }
  if (!rel || rel === "/") {
    throw new ObsError("inconsistent", "unit cgroup missing");
  }
  const full = `/sys/fs/cgroup${rel.startsWith("/") ? rel : `/${rel}`}`;
  if (!io.exists(full)) {
    throw new ObsError("inconsistent", "unit cgroup missing");
  }
  return full;
}

/**
 * @returns {object}
 */
export function createHostIo() {
  return {
    now() {
      return Number(process.hrtime.bigint() / 1000000n);
    },
    sleep(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },
    log(line) {
      process.stderr.write(`${line}\n`);
    },
    readFile(file) {
      return readFileSync(file);
    },
    exists(file) {
      return existsSync(file);
    },
    writeAtomic(file, text, mode) {
      const dir = path.dirname(file);
      const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
      const fd = openSync(tmp, "w", mode);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, mode);
      renameSync(tmp, file);
      chmodSync(file, mode);
    },
    listCgroupPids(root) {
      /** @type {number[]} */
      const pids = [];
      const walk = (dir) => {
        const procs = path.join(dir, "cgroup.procs");
        const text = readFileSync(procs, "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          const pid = Number(line.trim());
          if (!Number.isInteger(pid) || pid <= 0) {
            throw new ObsError("inconsistent", "cgroup inventory");
          }
          pids.push(pid);
        }
        for (const name of readdirSync(dir)) {
          const child = path.join(dir, name);
          let st;
          try {
            st = statSync(child);
          } catch (error) {
            if (error && error.code === "ENOENT") {
              continue;
            }
            throw error;
          }
          if (st.isDirectory()) {
            walk(child);
          }
        }
      };
      walk(root);
      return pids;
    },
    listProcPids() {
      /** @type {number[]} */
      const pids = [];
      let names;
      try {
        names = readdirSync("/proc");
      } catch (error) {
        throw asObsError(error);
      }
      for (const name of names) {
        if (/^[1-9]\d*$/.test(name)) {
          pids.push(Number(name));
        }
      }
      return pids;
    },
    realpath(file) {
      return realpathSync(file);
    },
    lstat(file) {
      return lstatSync(file);
    },
    unlink(file) {
      unlinkSync(file);
    },
    spawnKill(pm2Bin, pm2Home) {
      const child = spawn(pm2Bin, ["kill"], {
        env: { ...process.env, PM2_HOME: pm2Home },
        stdio: "ignore",
      });
      return {
        pid: child.pid ?? 0,
        finished: new Promise((resolve) => {
          child.once("error", () => resolve(1));
          child.once("exit", (code) => resolve(code ?? 1));
        }),
      };
    },
  };
}

function hostContext(io) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new ObsError("permission", "refusing root");
  }
  const pm2Home = process.env.PM2_HOME || "";
  const home = process.env.HOME || "";
  if (!pm2Home || !home) {
    throw new ObsError("inconsistent", "PM2_HOME missing");
  }
  return {
    io,
    pm2Home,
    home,
    uid: process.getuid(),
    unitCgroup: ownUnitCgroup(io),
    helperPid: process.pid,
    controlPids: controlChain(io, process.pid),
  };
}

/**
 * The helper and the commands that launched it inside the unit: this process and its ancestors
 * (start: helper bash, flock, bash -c). They are control, not service processes left behind.
 * @param {object} io
 * @param {number} pid
 * @returns {number[]}
 */
/**
 * Live pids of a `pm2 jlist`. A stopped app stays listed with pid 0 and has no
 * process: it is skipped. Any other non-positive or non-integer pid is inconsistent.
 * @param {unknown[]} rows
 * @returns {number[]}
 */
export function pidsFromJlist(rows) {
  const pids = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new ObsError("inconsistent", "jlist");
    const pid = Number(row.pid);
    if (pid === 0) continue;
    if (!Number.isInteger(pid) || pid < 0) {
      throw new ObsError("inconsistent", "jlist");
    }
    pids.push(pid);
  }
  return pids;
}

export function controlChain(io, pid) {
  const chain = [];
  let current = pid;
  for (let hop = 0; hop < 32 && Number.isInteger(current) && current > 1; hop += 1) {
    chain.push(current);
    let statText;
    try {
      statText = String(io.readFile(`/proc/${current}/stat`));
    } catch {
      break;
    }
    const close = statText.lastIndexOf(")");
    const fields = close >= 0 ? statText.slice(close + 1).trim().split(/\s+/) : [];
    const parent = Number(fields[1]);
    if (!Number.isInteger(parent) || parent === current) {
      break;
    }
    current = parent;
  }
  return chain;
}

function lockContext() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new ObsError("permission", "refusing root");
  }
  const pm2Home = process.env.PM2_HOME || "";
  if (!pm2Home) {
    throw new ObsError("inconsistent", "PM2_HOME missing");
  }
  return { pm2Home, uid: process.getuid() };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const held = args.includes("--held");
  const pm2Bin = args[1] && !args[1].startsWith("--") ? args[1] : "";
  const io = createHostIo();
  try {
    if (cmd === "validate-home") {
      const ctx = lockContext();
      const home = validatePm2Home(ctx.pm2Home, ctx.uid);
      ensureLockFile(home.lockPath, ctx.uid);
      process.exitCode = 0;
      return;
    }
    if (cmd === "stop") {
      if (!pm2Bin) {
        logLine(io, "usage stop <pm2-bin>");
        process.exitCode = 64;
        return;
      }
      const ctx = lockContext();
      const code = await withLifecycleLock({
        io,
        pm2Home: ctx.pm2Home,
        uid: ctx.uid,
        deadlineMs: STOP_DEADLINE_MS,
        acquire: acquireFlock,
      }, async (remain) => stopPm2({ ...hostContext(io), pm2Bin, deadlineMs: remain }));
      process.exitCode = code;
      return;
    }
    if (cmd === "post-stop") {
      const code = await verifyPostStop({
        ...hostContext(io),
        serviceResult: process.env.SERVICE_RESULT || "",
        exitCode: process.env.EXIT_CODE || "",
        exitStatus: process.env.EXIT_STATUS || "",
      });
      process.exitCode = code;
      return;
    }
    if (cmd === "guard") {
      const run = async () => guardPm2(hostContext(io));
      if (held) {
        process.exitCode = await run();
        return;
      }
      const ctx = lockContext();
      const code = await withLifecycleLock({
        io,
        pm2Home: ctx.pm2Home,
        uid: ctx.uid,
        deadlineMs: STOP_DEADLINE_MS,
        acquire: acquireFlock,
      }, run);
      process.exitCode = code;
      return;
    }
    logLine(io, "usage stop <pm2-bin> | guard | post-stop | validate-home");
    process.exitCode = 64;
  } catch (error) {
    logLine(io, `error=${asObsError(error).kind}`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  await main();
}
