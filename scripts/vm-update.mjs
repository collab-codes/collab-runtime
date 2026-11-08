#!/usr/bin/env node
// scripts/vm-update.mjs — `collab vm update <componente> [--dry-run]` (rt195 s2). First component: `timescaledb`.
//
// timescaledb: the package was upgraded (2.31) but each database still has the old extension (2.30): the new library
// is loaded only after a Postgres restart, and `ALTER EXTENSION timescaledb UPDATE` must be the FIRST command of a
// NEW session (psql -X -c, one session per database). Steps: check the package and the databases → restart Postgres →
// update each database in turn → stop at the first error naming the database. `--dry-run` only lists the plan.
//
// Idempotent: with every database at the package version it does nothing (no restart, no record). Whatever it did is
// recorded in the `vm` queue of the release record (releaseRecord.mjs, like update-collab-runtime.sh), also on failure.
// The code does not say "updated": the NEXT `collab vm inventory` does.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_DATABASE, readTimescale, realRun } from './vm-inventory.mjs';

const PG = ['sudo', '-n', '-u', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1'];
const RESTART_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const ALTER_TIMEOUT_MS = 300_000;

function realDeps(env) {
  return {
    run: realRun,
    env,
    exists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
    listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    write: (text) => process.stdout.write(text),
  };
}

/** First existing releaseRecord.mjs: the override, the cm main project's tree (shared.json), any project tree. */
export function findReleaseRecordScript({ env, exists, readText, listDir }) {
  const override = env.COLLAB_RELEASE_RECORD_SCRIPT;
  if (override && exists(override)) return override;
  const data = env.COLLAB_DATA_ROOT ?? '/data';
  const etc = env.COLLAB_ETC_DIR ?? join(data, 'etc');
  const rel = (project) => join(data, `app${project}`, 'mls-base', 'scripts', 'runtime', 'releaseRecord.mjs');
  try {
    const main = /"projetoPrincipal"\s*:\s*(\d+)/u.exec(readText(join(etc, 'shared.json')))?.[1];
    if (main && exists(rel(main))) return rel(main);
  } catch { /* no shared.json */ }
  for (const name of listDir(data).filter((entry) => /^app\d+$/u.test(entry)).sort()) {
    const candidate = rel(name.slice(3));
    if (exists(candidate)) return candidate;
  }
  return null;
}

async function waitPostgresReady(deps) {
  const deadline = deps.now() + (deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
  for (;;) {
    const result = await deps.run('pg_isready', [], { timeoutMs: 5000 });
    if (result.code === 0) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(1000);
  }
}

function writeRecord(deps, { before, after, steps, startedAt, result, failedStep, message }) {
  const script = findReleaseRecordScript(deps);
  if (!script) {
    deps.write('[WARN] release record: releaseRecord.mjs not found; skipped\n');
    return Promise.resolve(false);
  }
  const args = [script, 'vm', '--antes', before, '--depois', after, '--etc', deps.env.COLLAB_ETC_DIR ?? '/data/etc',
    '--passos', steps.join(','), '--inicio', startedAt, '--resultado', result, '--falha', failedStep ?? '', '--mensagem', message ?? ''];
  return deps.run('node', args, { timeoutMs: 30_000 }).then((out) => {
    if (out.code !== 0) deps.write('[WARN] release record not written\n');
    return out.code === 0;
  });
}

/**
 * `vm update timescaledb`. Returns { ok, nothing, dryRun, plan, databases, failure } and writes progress lines.
 * @param {{ dryRun?: boolean, env?: NodeJS.ProcessEnv, run?: Function, [k: string]: unknown }} options
 */
export async function updateTimescale({ dryRun = false, ...overrides } = {}) {
  const env = overrides.env ?? process.env;
  const deps = { ...realDeps(env), ...overrides, env };
  const { pkg, databases } = await readTimescale(deps.run);
  const behind = databases.filter(({ version }) => version !== pkg);
  const summary = { acao: 'timescaledb', dryRun, pacote: pkg, bancos: behind.map(({ db, version }) => ({ db, de: version, para: pkg })) };

  if (behind.length === 0) {
    deps.write(`timescaledb: ${databases.length} banco(s) já na ${pkg}; nada a fazer\n`);
    return { ...summary, ok: true, nothing: true };
  }
  deps.write(`timescaledb: pacote ${pkg}; extensão atrasada em ${behind.length} banco(s): ${behind.map(({ db, version }) => `${db} (${version})${db === TEMPLATE_DATABASE ? ' [modelo dos rascunhos]' : ''}`).join(', ')}\n`);
  if (dryRun) {
    deps.write('--dry-run: reiniciaria o Postgres e rodaria ALTER EXTENSION timescaledb UPDATE em cada banco acima, um por vez. Nada foi alterado.\n');
    return { ...summary, ok: true, nothing: false };
  }

  const startedAt = new Date(deps.now()).toISOString();
  const steps = [];
  const before = `timescaledb ${[...new Set(behind.map(({ version }) => version))].join(',')}`;
  const finish = async (result, failedStep, message) => {
    await writeRecord(deps, { before, after: `timescaledb ${pkg}`, steps, startedAt, result, failedStep, message });
    return { ...summary, ok: result === 'ok', nothing: false, ...(failedStep ? { falha: { passo: failedStep, mensagem: message } } : {}) };
  };

  steps.push('restart-postgres');
  deps.write('timescaledb: reiniciando o Postgres para carregar a biblioteca nova\n');
  const restart = await deps.run('systemctl', ['restart', 'postgresql'], { timeoutMs: deps.restartTimeoutMs ?? RESTART_TIMEOUT_MS });
  if (restart.code !== 0) return finish('falhou', 'restart-postgres', `systemctl restart postgresql: exit ${restart.code}`);
  if (!(await waitPostgresReady(deps))) return finish('falhou', 'restart-postgres', 'o Postgres não voltou a aceitar conexões no prazo');

  for (const { db, version } of behind) {
    steps.push(`alter:${db}`);
    deps.write(`timescaledb: ${db} ${version} -> ${pkg}\n`);
    // a NEW session whose first command is the ALTER (psql -X -c): required by TimescaleDB
    const result = await deps.run(PG[0], [...PG.slice(1), '-d', db, '-c', 'ALTER EXTENSION timescaledb UPDATE'], { timeoutMs: deps.alterTimeoutMs ?? ALTER_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = String(result.err || result.out).split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? `exit ${result.code}`;
      return finish('falhou', `alter:${db}`, `${db}: ${detail}`);
    }
  }
  deps.write(`timescaledb: ${behind.length} banco(s) atualizado(s); confira com collab vm inventory\n`);
  return finish('ok');
}

function invokedAsMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  const [component, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');
  if (component !== 'timescaledb' || flags.some((flag) => flag !== '--dry-run')) {
    process.stderr.write('Usage: collab vm update timescaledb [--dry-run]\n');
    process.exit(2);
  }
  updateTimescale({ dryRun }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  }).catch((error) => {
    process.stderr.write(`vm update timescaledb: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
