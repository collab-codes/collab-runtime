// PM2-only stop order shared by ExecStop and VM shutdown:
// business apps -> msg-worker -> msg. PM2 modules (pmx_module) stay for the final daemon close.
// Pure policy: no imports of agent/lifecycle, no Redis/PostgreSQL/nginx/systemctl, no `pm2 all`/`kill`.
// The caller injects the stop action, the passive observation, the clock and the abort signal.

/** Phases in dependency order. The only copy of this list. */
export const PM2_STOP_PHASES = Object.freeze(["apps", "msg-worker", "msg"]);
const PLATFORM = new Set(["msg-worker", "msg"]);

/**
 * @typedef {{ name: string, pmId: number|null, pid: number, startTime: number|null }} Pm2Instance
 * @typedef {{ phase: string, names: string[], instances: Pm2Instance[] }} Pm2Phase
 * @typedef {"stopped"|"not_applicable"|"unconfirmed"|"blocked"} PhaseResult
 */

/** True for PM2 modules (pm2-logrotate and similar); accepts passive rows or normalized ones. */
export function isPm2Module(row) {
  return row?.pmxModule === true || row?.pmx_module === true || row?.pm2_env?.pmx_module === true;
}

function instanceOf(row) {
  if (!row || typeof row.name !== "string" || row.name === "") return null;
  const pid = row.pid == null ? 0 : Number(row.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const pmIdRaw = row.pm_id ?? row.pmId;
  const pmId = Number.isInteger(pmIdRaw) ? pmIdRaw : null;
  const startRaw = row.startTime ?? row.pm2_env?.pm_uptime;
  const startTime = Number.isInteger(startRaw) ? startRaw : null;
  return { name: row.name, pmId, pid, startTime };
}

/** Live, non-module instances of an inventory. A row with pid 0/absent is gone. */
export function liveInstances(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isPm2Module(row)) continue;
    const inst = instanceOf(row);
    if (inst) out.push(inst);
  }
  return out;
}

/**
 * Groups a real inventory into the ordered phases. Names are deduplicated per phase;
 * every instance (cluster/fork copies with the same name) is kept.
 * @returns {{ phases: Pm2Phase[], modules: string[] }}
 */
export function planPm2StopOrder(rows) {
  /** @type {Map<string, Pm2Phase>} */
  const byPhase = new Map(PM2_STOP_PHASES.map((phase) => [phase, { phase, names: [], instances: [] }]));
  const modules = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isPm2Module(row)) {
      if (typeof row?.name === "string" && !modules.includes(row.name)) modules.push(row.name);
      continue;
    }
    const inst = instanceOf(row);
    if (!inst) continue;
    const target = byPhase.get(PLATFORM.has(inst.name) ? inst.name : "apps");
    if (!target.names.includes(inst.name)) target.names.push(inst.name);
    target.instances.push(inst);
  }
  const phases = PM2_STOP_PHASES.map((phase) => byPhase.get(phase));
  phases[0].names.sort();
  modules.sort();
  return { phases, modules };
}

function stillAlive(phase, rows) {
  const names = new Set(phase.names);
  return liveInstances(rows).filter((inst) => names.has(inst.name));
}

/**
 * Runs the phases in order under one deadline. A phase only starts when every instance of the
 * previous one is confirmed gone by `observe`; a successful stop command alone proves nothing.
 *
 * @param {{
 *   inventory: unknown[],
 *   remainingMs: number,
 *   stop: (phase: Pm2Phase, deadlineAt: number) => Promise<boolean|void>,
 *   observe: () => Promise<{ ok: boolean, processes?: unknown[] }>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, modules: string[], phases: Array<Pm2Phase & { result: PhaseResult }> }>}
 */
export async function runPm2StopOrder(options) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 200;
  const log = options.log ?? (() => {});
  const remaining = Number(options.remainingMs);
  const deadlineAt = now() + (Number.isFinite(remaining) && remaining > 0 ? remaining : 0);
  const aborted = () => options.signal?.aborted === true;
  const plan = planPm2StopOrder(options.inventory);
  const results = [];
  let blocked = false;

  for (const phase of plan.phases) {
    if (blocked) {
      results.push({ ...phase, result: "blocked" });
      log(`stage=pm2-${phase.phase} result=blocked`);
      continue;
    }
    if (phase.instances.length === 0) {
      results.push({ ...phase, result: "not_applicable" });
      log(`stage=pm2-${phase.phase} result=not_applicable`);
      continue;
    }
    const result = await runPhase(phase);
    results.push({ ...phase, result });
    log(`stage=pm2-${phase.phase} names=${phase.names.join(",")} result=${result}`);
    if (result !== "stopped") blocked = true;
  }
  return { ok: !blocked, modules: plan.modules, phases: results };

  /** @param {Pm2Phase} phase @returns {Promise<PhaseResult>} */
  async function runPhase(phase) {
    if (aborted() || now() >= deadlineAt) return "unconfirmed";
    try {
      if ((await options.stop(phase, deadlineAt)) === false) return "unconfirmed";
    } catch (error) {
      log(`stage=pm2-${phase.phase} stop_error=${error instanceof Error ? error.message : String(error)}`);
      return "unconfirmed";
    }
    for (;;) {
      if (aborted() || now() >= deadlineAt) return "unconfirmed";
      let seen;
      try {
        seen = await options.observe();
      } catch (error) {
        log(`stage=pm2-${phase.phase} observe_error=${error instanceof Error ? error.message : String(error)}`);
        return "unconfirmed";
      }
      if (!seen || seen.ok !== true || !Array.isArray(seen.processes)) return "unconfirmed";
      if (stillAlive(phase, seen.processes).length === 0) return "stopped";
      const slice = Math.min(pollMs, deadlineAt - now());
      if (slice <= 0 || aborted()) return "unconfirmed";
      await sleep(slice);
    }
  }
}
