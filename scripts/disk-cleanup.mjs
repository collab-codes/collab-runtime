#!/usr/bin/env node
/**
 * rt304 s2 — daily disk cleanup of the VM.
 *
 * Runs `scripts/runtime/pruneBuildCache.mjs` of every app tree (`<dataRoot>/app<id>/mls-base`), measures `/` and the data
 * root before and after, and records the run in `<etcDir>/disk-cleanup/last.json` (the agent heartbeat reads it).
 * Triggered by two systemd timers (see 16-disk-cleanup-timers.sh): 02:00 UTC every day, and 10 minutes after boot but
 * only when the last cleanup finished more than 30 hours ago. Never run by hand on a VM unless the owner says so.
 *
 *   node scripts/disk-cleanup.mjs [--trigger=timer|boot|manual] [--if-last-older-than=30h]
 *
 * A new thing that grows without bound becomes one more call in `cleanTrees`; the trigger does not change.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDisks } from "../agent/collab-sites-agent.mjs";

export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
export const TREE_TIMEOUT_MS = 30 * 60 * 1000;
const PRUNE_SCRIPT = "scripts/runtime/pruneBuildCache.mjs";

export function lastFile(etcDir) {
  return join(etcDir, "disk-cleanup", "last.json");
}

function lockFile(etcDir) {
  return join(etcDir, "disk-cleanup", "lock");
}

/** `30h` → milliseconds; `null` for anything else. */
export function parseHours(text) {
  const match = /^(\d+)h$/u.exec(String(text ?? "").trim());
  return match ? Number(match[1]) * 60 * 60 * 1000 : null;
}

/** The last run, or `null` when the file is absent or unreadable. */
export function readLast(etcDir) {
  try {
    const record = JSON.parse(readFileSync(lastFile(etcDir), "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

/** Whether a run is due: no usable last run, or it finished more than `minAgeMs` ago. */
export function isDue(last, nowMs, minAgeMs) {
  const finished = Date.parse(last?.finishedAt ?? "");
  if (!Number.isFinite(finished)) return true;
  return nowMs - finished > minAgeMs;
}

/** Takes the single-run lock; a lock older than `LOCK_STALE_MS` is taken over. Returns a release function, or `null` when held. */
export function acquireLock(etcDir, nowMs) {
  const path = lockFile(etcDir);
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: new Date(nowMs).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let heldAt = Number.NaN;
      try {
        heldAt = Date.parse(JSON.parse(readFileSync(path, "utf8")).at);
      } catch { /* a broken lock file counts as old */ }
      if (Number.isFinite(heldAt) && nowMs - heldAt < LOCK_STALE_MS) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

/** `<dataRoot>/app<id>/mls-base` trees. */
export function findTrees(dataRoot) {
  if (!existsSync(dataRoot)) return [];
  return readdirSync(dataRoot)
    .filter((name) => /^app\d+$/u.test(name))
    .sort()
    .map((name) => join(dataRoot, name, "mls-base"))
    .filter((root) => existsSync(root));
}

function defaultExec(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: TREE_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

/** One tree: its own prune script decides what goes. A failure is recorded and never stops the next tree. */
export function cleanTree(root, exec = defaultExec, exists = existsSync) {
  const script = join(root, PRUNE_SCRIPT);
  if (!exists(script)) return { root, ok: true, skipped: "sem pruneBuildCache.mjs", freedKb: 0, removed: 0 };
  const result = exec("node", [script, "--root", root, "--json"]);
  if (result.status !== 0) {
    const detail = (result.error?.message ?? result.stderr ?? "").trim().split("\n").pop() ?? "";
    return { root, ok: false, error: `exit ${result.status}${detail ? `: ${detail}` : ""}`.slice(0, 300), freedKb: 0, removed: 0 };
  }
  try {
    const parsed = JSON.parse(String(result.stdout).trim().split("\n").pop() ?? "");
    const entry = { root, ok: true, freedKb: Number(parsed.freedKb) || 0, removed: Array.isArray(parsed.removed) ? parsed.removed.length : 0 };
    if (parsed.skipped) entry.skipped = String(parsed.skipped);
    return entry;
  } catch {
    return { root, ok: false, error: "saida do pruneBuildCache nao e JSON", freedKb: 0, removed: 0 };
  }
}

/**
 * The whole run. `deps` is for tests: `now`, `exec`, `disks` (reads `df`), `trees`, `exists`.
 * @returns {{ ran: boolean, reason?: string, record?: object }}
 */
export function runCleanup({ dataRoot = "/data", etcDir, trigger = "timer", minAgeMs = null, deps = {} } = {}) {
  const etc = etcDir ?? join(dataRoot, "etc");
  const now = deps.now ?? (() => Date.now());
  const readDisks = deps.disks ?? (() => collectDisks({ dataRoot }));
  if (minAgeMs !== null && !isDue(readLast(etc), now(), minAgeMs)) return { ran: false, reason: "ultima limpeza recente" };
  const release = acquireLock(etc, now());
  if (!release) return { ran: false, reason: "ja esta rodando" };
  try {
    const startedAt = new Date(now()).toISOString();
    const disksBefore = readDisks();
    const trees = (deps.trees ?? findTrees)(dataRoot).map((root) => cleanTree(root, deps.exec, deps.exists));
    const disksAfter = readDisks();
    const record = {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      ok: trees.every((tree) => tree.ok),
      trigger,
      trees,
      freedKb: trees.reduce((sum, tree) => sum + tree.freedKb, 0),
      ...(disksBefore ? { disksBefore } : {}),
      ...(disksAfter ? { disksAfter } : {}),
    };
    const target = lastFile(etc);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, target);
    return { ran: true, record };
  } finally {
    release();
  }
}

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const dataRoot = env.COLLAB_DATA_ROOT || "/data";
  const etcDir = env.COLLAB_ETC_DIR || join(dataRoot, "etc");
  const olderThan = argValue(argv, "if-last-older-than");
  const minAgeMs = olderThan === undefined ? null : parseHours(olderThan);
  if (olderThan !== undefined && minAgeMs === null) {
    console.error(`disk-cleanup: --if-last-older-than=${olderThan} invalido (use Nh, ex.: 30h)`);
    return 2;
  }
  const outcome = runCleanup({ dataRoot, etcDir, trigger: argValue(argv, "trigger") || "timer", minAgeMs });
  if (!outcome.ran) {
    console.log(`disk-cleanup: nada a fazer (${outcome.reason})`);
    return 0;
  }
  const { record } = outcome;
  console.log(`disk-cleanup: ok=${record.ok} liberou ${record.freedKb} KB em ${record.trees.length} arvore(s)`);
  for (const tree of record.trees) if (!tree.ok) console.error(`disk-cleanup: ${tree.root} falhou: ${tree.error}`);
  return record.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
