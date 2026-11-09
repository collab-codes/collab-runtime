#!/usr/bin/env node
// scripts/vm-inventory.mjs — `collab vm inventory` (rt195 s1): what is INSTALLED on this VM, read only.
//
// Runs only when the sites asks (SSM), never on a timer and never from the heartbeat. It prints one human line per
// component and, as the LAST line, the JSON of the `vm-inventory` contract v1:
//   { versaoContrato: 1, vmId, geradoEm, duracaoMs, componentes: [ { id, instalado, estado?, acao?, exigeReinicio?, detalhe? } ] }
// The wanted versions live in the sites (an editable manifest), never here: the VM only says what it has. A component
// states `estado` itself only when it can tell without a manifest (the TimescaleDB package × the extension in each
// database). No secret is read: versions, hashes, counts and names only. A read that fails (or hangs) becomes
// `estado: "erro"` with `detalhe`; it never takes the other components down.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareAgent } from './vm-agent.mjs';

export const CONTRACT_VERSION = 1;
export const COMPONENT_TIMEOUT_MS = 2500;
/** A component with its own deadline (rt199): the system packages come from the cache file and must never hold the total. */
export const COMPONENT_TIMEOUTS_MS = { sistema: 1000 };
export const UPDATES_CACHE_FILE = '/var/lib/update-notifier/updates-available';
export const TEMPLATE_DATABASE = 'template1';
const dbLabel = (db) => (db === TEMPLATE_DATABASE ? `${db} (modelo dos rascunhos)` : db);
const PG = ['sudo', '-n', '-u', 'postgres', 'psql', '-X', '-At'];

/** Run a command with a deadline. Never throws: a missing binary is code 127, a timeout is code 124. */
export function realRun(command, args, { timeoutMs = COMPONENT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      err = error instanceof Error ? error.message : String(error);
      resolve({ code: 127, out, err });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(124);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { err += error.message; done(127); });
    child.on('close', (code) => done(code ?? 1));
  });
}

const firstLine = (text) => String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? '';
const sha12 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);

async function ok(run, command, args, what) {
  const result = await run(command, args);
  if (result.code !== 0) {
    throw new Error(`${what}: exit ${result.code}${firstLine(result.err) ? ` (${firstLine(result.err)})` : ''}`);
  }
  return result.out;
}

/** The versions the TimescaleDB package and each database's extension are at. Shared with `vm update timescaledb`. */
export async function readTimescale(run) {
  const pkgOut = await ok(run, 'dpkg-query', ['-W', '-f', '${Package}|${Version}\\n', 'timescaledb-2-postgresql-*'], 'dpkg-query timescaledb');
  const pkgLine = firstLine(pkgOut);
  if (!pkgLine) throw new Error('pacote timescaledb-2-postgresql-* não instalado');
  const [pkgName, pkgFull] = pkgLine.split('|');
  const pkg = String(pkgFull).split('~')[0];
  // `template1` COUNTS (rt196): the draft databases are made with `CREATE DATABASE` from it, so a template left behind makes
  // every new draft be born one version late. It comes first: a draft created during the update is born updated.
  const dbsOut = await ok(run, PG[0], [...PG.slice(1), '-c', "select datname from pg_database where datallowconn order by (datname = 'template1') desc, 1"], 'psql databases');
  const names = dbsOut.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const databases = [];
  for (const db of names) {
    const out = await ok(run, PG[0], [...PG.slice(1), '-d', db, '-c', "select extversion from pg_extension where extname='timescaledb'"], `psql ${db}`);
    const version = firstLine(out);
    if (version) databases.push({ db, version });
  }
  return { pkgName, pkg, databases };
}

const READERS = {
  'collab-runtime': async ({ run, env }) => {
    const dir = env.COLLAB_RUNTIME_DIR ?? '/data/collab-runtime';
    const out = await ok(run, 'git', ['-c', 'safe.directory=*', '-C', dir, 'rev-parse', '--short=7', 'HEAD'], 'git rev-parse');
    return { instalado: firstLine(out), estado: 'ok' };
  },

  agente: async ({ env, exists, hashOf }) => {
    const runtimeDir = env.COLLAB_RUNTIME_DIR ?? '/data/collab-runtime';
    const prefix = env.COLLAB_SHUTDOWN_PREFIX ?? '';
    const main = join(prefix || '/', 'usr/local/lib/collab-sites-agent/collab-sites-agent.mjs');
    if (!exists(main)) throw new Error(`agente não instalado em ${main}`);
    const diff = compareAgent({ runtimeDir, prefix, exists, hashOf });
    if (diff.changed.length === 0) {
      return { instalado: diff.installedMain, estado: 'ok', ...(diff.checkoutMain ? {} : { detalhe: 'sem checkout para comparar' }) };
    }
    return {
      instalado: diff.installedMain || hashOf(main),
      estado: 'desatualizado',
      acao: 'agente',
      ...(diff.restartNeeded ? { exigeReinicio: true } : {}),
      detalhe: `${diff.changed.map((c) => `${c.file}${c.reason === 'not-installed' ? ' (não instalado)' : ''}`).join(', ')}${diff.checkoutMain ? `; checkout ${diff.checkoutMain}` : ''}`,
    };
  },

  pm2: async ({ run, env, exists, readText, listDir }) => {
    const bin = firstLine((await run('sh', ['-c', 'command -v pm2'])).out);
    const roots = [];
    if (bin) {
      try { roots.push(join(realpathSync(bin), '..', '..', 'package.json')); } catch { /* not resolvable */ }
    }
    roots.push('/usr/lib/node_modules/pm2/package.json', '/usr/local/lib/node_modules/pm2/package.json');
    const pkgPath = roots.find((path) => exists(path));
    if (!pkgPath) throw new Error('package.json do pm2 não encontrado (o CLI não roda pm2: pode subir o daemon)');
    const version = JSON.parse(readText(pkgPath)).version;
    // the boot unit's drop-in names the config pm2 resurrects (the apps aggregator)
    const systemd = env.COLLAB_SYSTEMD_DIR ?? '/etc/systemd/system';
    let target = '';
    for (const unit of listDir(systemd).filter((name) => /^pm2-.+\.service\.d$/u.test(name))) {
      const file = join(systemd, unit, 'fixed-configs.conf');
      if (!exists(file)) continue;
      target = /([^\s"']+\.config\.js)/u.exec(readText(file))?.[1] ?? '';
      if (target) break;
    }
    return { instalado: String(version), estado: 'ok', detalhe: target ? `alvo do boot: ${target}` : 'drop-in do boot não encontrado' };
  },

  postgres: async ({ run }) => {
    const sql = "select current_setting('server_version')||'|'||current_setting('max_worker_processes')||'|'||coalesce(current_setting('timescaledb.max_background_workers', true),'')||'|'||current_setting('max_parallel_workers')";
    const out = firstLine(await ok(run, PG[0], [...PG.slice(1), '-c', sql], 'psql settings'));
    const [version, workers, tsWorkers, parallel] = out.split('|');
    return {
      instalado: String(version).split(/\s+/u)[0],
      estado: 'ok',
      detalhe: `max_worker_processes=${workers} timescaledb.max_background_workers=${tsWorkers || '-'} max_parallel_workers=${parallel}`,
    };
  },

  timescaledb: async ({ run }) => {
    const { pkg, databases } = await readTimescale(run);
    const groups = new Map();
    for (const { db, version } of databases) groups.set(version, [...(groups.get(version) ?? []), db]);
    const detail = databases.length === 0
      ? 'nenhum banco com a extensão'
      : [...groups].map(([version, dbs]) => `extensão ${version}: ${dbs.length} banco(s)${version === pkg ? '' : ` (${dbs.map(dbLabel).join(', ')})`}`).join('; ');
    const behind = databases.some(({ version }) => version !== pkg);
    return behind
      ? { instalado: pkg, estado: 'desatualizado', acao: 'timescaledb', exigeReinicio: true, detalhe: detail }
      : { instalado: pkg, estado: 'ok', detalhe: detail };
  },

  nginx: async ({ run }) => {
    const result = await run('nginx', ['-v']); // prints to stderr: "nginx version: nginx/1.24.0 (Ubuntu)"
    const match = /nginx\/(\S+)/u.exec(`${result.err}${result.out}`);
    if (!match) throw new Error(`nginx -v: exit ${result.code}`);
    return { instalado: match[1], estado: 'ok' };
  },

  node: async ({ run }) => ({ instalado: firstLine(await ok(run, 'node', ['--version'], 'node --version')).replace(/^v/u, ''), estado: 'ok' }),

  deno: async ({ run }) => {
    const out = firstLine(await ok(run, 'deno', ['--version'], 'deno --version')); // "deno 2.1.4 (stable, release, …)"
    return { instalado: /deno\s+(\S+)/u.exec(out)?.[1] ?? out, estado: 'ok' };
  },

  redis: async ({ run }) => {
    const out = await ok(run, 'redis-server', ['--version'], 'redis-server --version'); // "Redis server v=7.0.15 sha=…"
    const match = /v=(\S+)/u.exec(out);
    if (!match) throw new Error(`redis-server --version: saída inesperada (${firstLine(out)})`);
    return { instalado: match[1], estado: 'ok' };
  },

  // The count the system already keeps (`/var/lib/update-notifier/updates-available`, refreshed by apt itself): a file read.
  // `apt-get -s upgrade` takes ~2.2 s on the 102056 and has no place in a 1 s budget. No cache file = an error saying so.
  sistema: async ({ exists, readText }) => {
    if (!exists(UPDATES_CACHE_FILE)) throw new Error(`sem ${UPDATES_CACHE_FILE} (o apt não gerou o cache de atualizações)`);
    const pending = Number(/(\d+)\s+updates?\s+can\s+be\s+(?:applied|installed)/iu.exec(readText(UPDATES_CACHE_FILE))?.[1] ?? 0);
    const reboot = exists('/var/run/reboot-required');
    const parts = [`${pending} pacote(s) a atualizar`];
    if (reboot) parts.push('reboot pedido');
    return {
      instalado: `${pending} pacote(s) a atualizar`,
      estado: pending > 0 || reboot ? 'desatualizado' : 'ok',
      ...(reboot ? { exigeReinicio: true } : {}),
      detalhe: parts.join('; '),
    };
  },

  disco: async ({ run }) => {
    const out = await ok(run, 'df', ['-Pk', '/', '/data'], 'df');
    const rows = out.split(/\r?\n/u).slice(1).map((line) => line.trim().split(/\s+/u)).filter((cols) => cols.length >= 6);
    if (rows.length === 0) throw new Error('df sem linhas');
    const gb = (kb) => (Number(kb) / 1048576).toFixed(1);
    return {
      instalado: rows.map((cols) => `${cols[5]} ${cols[4]}`).join(' · '),
      estado: 'ok',
      detalhe: rows.map((cols) => `${cols[5]}: ${gb(cols[2])} de ${gb(cols[1])} GB`).join('; '),
    };
  },
};

export const COMPONENT_IDS = Object.keys(READERS);

function realDeps(env) {
  return {
    run: realRun,
    env,
    exists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
    hashOf: sha12,
    listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
    now: () => Date.now(),
    vmId: () => {
      if (String(env.COLLAB_VM_ID ?? '').trim()) return String(env.COLLAB_VM_ID).trim();
      try {
        const line = readFileSync('/etc/collab/sites-agent.env', 'utf8').split(/\r?\n/u).find((row) => row.startsWith('COLLAB_SITES_SERVER_ID='));
        const value = line ? line.slice('COLLAB_SITES_SERVER_ID='.length).trim().replace(/^["']|["']$/gu, '') : '';
        if (value) return value;
      } catch { /* no agent here */ }
      return hostname();
    },
  };
}

/** One component: its reader's result, or `estado: "erro"` when it throws or does not answer in time. */
async function readComponent(id, deps, timeoutMs) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`sem resposta em ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([READERS[id](deps), deadline]);
    return { id, ...result };
  } catch (error) {
    return { id, instalado: '', estado: 'erro', detalhe: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The `vm-inventory` v1 document. All components are read at once, so the total is about the slowest read. */
export async function buildInventory(overrides = {}) {
  const env = overrides.env ?? process.env;
  const deps = { ...realDeps(env), ...overrides };
  const startedAt = deps.now();
  const timeoutOf = (id) => overrides.timeoutMs ?? COMPONENT_TIMEOUTS_MS[id] ?? COMPONENT_TIMEOUT_MS;
  const componentes = await Promise.all(COMPONENT_IDS.map((id) => readComponent(id, deps, timeoutOf(id))));
  return {
    versaoContrato: CONTRACT_VERSION,
    vmId: deps.vmId(),
    geradoEm: new Date(startedAt).toISOString(),
    duracaoMs: deps.now() - startedAt,
    componentes,
  };
}

export function formatInventory(inventory) {
  const lines = inventory.componentes.map((c) => `${c.id.padEnd(15)} ${String(c.instalado || '-').padEnd(22)} ${c.estado ?? ''}${c.detalhe ? `  ${c.detalhe}` : ''}`);
  return `${lines.join('\n')}\n${JSON.stringify(inventory)}\n`;
}

function invokedAsMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  buildInventory().then((inventory) => {
    process.stdout.write(formatInventory(inventory));
  }).catch((error) => {
    process.stderr.write(`vm inventory: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
