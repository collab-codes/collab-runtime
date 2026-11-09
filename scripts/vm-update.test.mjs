import test from 'node:test';
import assert from 'node:assert/strict';
import { findReleaseRecordScript, restartAgent, updateAgent, updateTimescale } from './vm-update.mjs';

// Fake machine for the update: databases and their extension versions are state; commands change it like the real ones.
function machine({ pkg = '2.31.0', dbs = { a: '2.30.0', b: '2.30.0', c: '2.30.0' }, failAlterOn = null, restartCode = 0, ready = true } = {}) {
  const state = { dbs: { ...dbs }, calls: [], writes: [], restarts: 0 };
  const run = async (command, args) => {
    const line = [command, ...args].join(' ');
    state.calls.push(line);
    if (command === 'dpkg-query') return { code: 0, out: `timescaledb-2-postgresql-17|${pkg}~ubuntu24.04-1700\n`, err: '' };
    if (line.includes('select datname')) {
      // the real query orders template1 first
      const names = Object.keys(state.dbs).sort((x, y) => (y === 'template1') - (x === 'template1') || x.localeCompare(y));
      return { code: 0, out: `${names.join('\n')}\n`, err: '' };
    }
    if (line.includes('select extversion')) {
      const db = args[args.indexOf('-d') + 1];
      return { code: 0, out: `${state.dbs[db]}\n`, err: '' };
    }
    if (command === 'systemctl') { state.restarts += 1; return { code: restartCode, out: '', err: '' }; }
    if (command === 'pg_isready') return { code: ready ? 0 : 2, out: '', err: '' };
    if (line.includes('ALTER EXTENSION')) {
      const db = args[args.indexOf('-d') + 1];
      if (db === failAlterOn) return { code: 1, out: '', err: 'ERROR: extension "timescaledb" must be updated in a fresh session\n' };
      state.dbs[db] = pkg;
      return { code: 0, out: 'ALTER EXTENSION\n', err: '' };
    }
    if (command === 'node') { state.record = args; return { code: 0, out: 'recorded vm x ok\n', err: '' }; }
    return { code: 127, out: '', err: 'unexpected' };
  };
  const files = { '/data/etc/shared.json': '{"projetoPrincipal":102047}', '/data/app102047/mls-base/scripts/runtime/releaseRecord.mjs': '' };
  Object.assign(state, {
    deps: {
      run, env: { COLLAB_ETC_DIR: '/data/etc' }, now: (() => { let t = 0; return () => (t += 1); })(), sleep: async () => {},
      exists: (path) => path in files, readText: (path) => files[path], listDir: () => ['app102047'],
      write: (text) => state.writes.push(text), readyTimeoutMs: 5,
    },
  });
  return state;
}
const alters = (m) => m.calls.filter((line) => line.includes('ALTER EXTENSION'));

test('atualiza o pacote já instalado: reinicia o Postgres uma vez e faz o ALTER em cada banco, um por vez', async () => {
  const m = machine();
  const result = await updateTimescale({ ...m.deps });
  assert.equal(result.ok, true);
  assert.equal(m.restarts, 1);
  assert.equal(alters(m).length, 3);
  assert.deepEqual(Object.values(m.dbs), ['2.31.0', '2.31.0', '2.31.0']);
  // order: restart, then the alters
  const restartAt = m.calls.findIndex((line) => line.startsWith('systemctl'));
  assert.ok(restartAt < m.calls.findIndex((line) => line.includes('ALTER EXTENSION')));
  // each ALTER is the first command of a new psql session (-X, -c, one -d per call)
  for (const line of alters(m)) assert.match(line, /psql -X -At -v ON_ERROR_STOP=1 -d \w+ -c ALTER EXTENSION timescaledb UPDATE$/u);
});

test('--dry-run só lista: não reinicia, não altera, não registra', async () => {
  const m = machine();
  const result = await updateTimescale({ dryRun: true, ...m.deps });
  assert.equal(result.ok, true);
  assert.equal(m.restarts, 0);
  assert.equal(alters(m).length, 0);
  assert.equal(m.record, undefined);
  assert.deepEqual(result.bancos.map((b) => b.db), ['a', 'b', 'c']);
  assert.match(m.writes.join(''), /--dry-run/u);
  assert.deepEqual(Object.values(m.dbs), ['2.30.0', '2.30.0', '2.30.0']);
});

test('para no primeiro banco com erro, nomeia o banco e registra a falha', async () => {
  const m = machine({ failAlterOn: 'b' });
  const result = await updateTimescale({ ...m.deps });
  assert.equal(result.ok, false);
  assert.equal(result.falha.passo, 'alter:b');
  assert.match(result.falha.mensagem, /^b: ERROR: extension "timescaledb" must be updated/u);
  assert.equal(alters(m).length, 2, 'a e b; c nunca é tentado');
  assert.equal(m.dbs.a, '2.31.0');
  assert.equal(m.dbs.c, '2.30.0');
  const args = m.record;
  assert.equal(args[args.indexOf('--resultado') + 1], 'falhou');
  assert.equal(args[args.indexOf('--falha') + 1], 'alter:b');
});

test('registra na fila vm com antes, depois e os passos (também no sucesso)', async () => {
  const m = machine({ dbs: { a: '2.30.0', b: '2.30.1' } });
  await updateTimescale({ ...m.deps });
  const args = m.record;
  assert.equal(args[0], '/data/app102047/mls-base/scripts/runtime/releaseRecord.mjs');
  assert.equal(args[1], 'vm');
  assert.equal(args[args.indexOf('--antes') + 1], 'timescaledb 2.30.0,2.30.1');
  assert.equal(args[args.indexOf('--depois') + 1], 'timescaledb 2.31.0');
  assert.equal(args[args.indexOf('--passos') + 1], 'restart-postgres,alter:a,alter:b');
  assert.equal(args[args.indexOf('--resultado') + 1], 'ok');
  assert.equal(args[args.indexOf('--etc') + 1], '/data/etc');
});

test('tudo em dia: não faz nada (sem reinício, sem ALTER, sem registro)', async () => {
  const m = machine({ dbs: { a: '2.31.0', b: '2.31.0' } });
  const result = await updateTimescale({ ...m.deps });
  assert.equal(result.ok, true);
  assert.equal(result.nothing, true);
  assert.equal(m.restarts, 0);
  assert.equal(alters(m).length, 0);
  assert.equal(m.record, undefined);
  // and a second run after an update is a no-op
  const again = machine();
  await updateTimescale({ ...again.deps });
  const before = again.calls.length;
  const second = await updateTimescale({ ...again.deps, run: again.deps.run });
  assert.equal(second.nothing, true);
  assert.equal(again.restarts, 1);
  assert.ok(again.calls.length > before);
});

test('o Postgres que não reinicia ou não volta falha no passo restart-postgres, sem ALTER', async () => {
  const bad = machine({ restartCode: 1 });
  const r1 = await updateTimescale({ ...bad.deps });
  assert.equal(r1.falha.passo, 'restart-postgres');
  assert.equal(alters(bad).length, 0);
  const down = machine({ ready: false });
  const r2 = await updateTimescale({ ...down.deps });
  assert.equal(r2.falha.passo, 'restart-postgres');
  assert.match(r2.falha.mensagem, /não voltou/u);
  assert.equal(alters(down).length, 0);
});

test('sem o releaseRecord.mjs a atualização roda e só avisa', async () => {
  const m = machine();
  const result = await updateTimescale({ ...m.deps, exists: () => false, listDir: () => [], readText: () => { throw new Error('no file'); } });
  assert.equal(result.ok, true);
  assert.equal(m.record, undefined);
  assert.match(m.writes.join(''), /\[WARN\] release record: releaseRecord\.mjs not found/u);
});

test('findReleaseRecordScript: override, projeto principal, qualquer árvore de projeto', () => {
  const files = { '/x/rr.mjs': '', '/data/app102056/mls-base/scripts/runtime/releaseRecord.mjs': '' };
  const base = { exists: (p) => p in files, readText: () => { throw new Error('none'); }, listDir: () => ['app102056', 'other'] };
  assert.equal(findReleaseRecordScript({ ...base, env: { COLLAB_RELEASE_RECORD_SCRIPT: '/x/rr.mjs' } }), '/x/rr.mjs');
  assert.equal(findReleaseRecordScript({ ...base, env: {} }), '/data/app102056/mls-base/scripts/runtime/releaseRecord.mjs');
  assert.equal(findReleaseRecordScript({ ...base, exists: () => false, env: {} }), null);
});

test('rt196: o banco-modelo (template1) entra, vai primeiro, e um rascunho criado depois nasce na versão nova', async () => {
  const m = machine({ dbs: { a: '2.30.0', template1: '2.30.0', b: '2.30.0' } });
  const result = await updateTimescale({ ...m.deps });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bancos.map((b) => b.db), ['template1', 'a', 'b'], 'template1 primeiro');
  const order = alters(m).map((line) => /-d (\w+)/u.exec(line)[1]);
  assert.deepEqual(order, ['template1', 'a', 'b']);
  assert.match(m.writes.join(''), /template1 \(2\.30\.0\) \[modelo dos rascunhos\]/u);
  // CREATE DATABASE copies template1: a draft database created now is born at the package version
  const bornNow = m.dbs.template1;
  assert.equal(bornNow, '2.31.0');
});

test('rt196: os bancos de rascunho que já existem em versão antiga entram no mesmo update', async () => {
  const m = machine({ dbs: { collab_app_draft_team_102056: '2.30.0', collab_app_draft_102056_u44dd34ecef2b: '2.30.0', template1: '2.30.0', outro: '2.31.0' } });
  const result = await updateTimescale({ ...m.deps });
  assert.deepEqual(result.bancos.map((b) => b.db).sort(), ['collab_app_draft_102056_u44dd34ecef2b', 'collab_app_draft_team_102056', 'template1']);
  assert.deepEqual(Object.values(m.dbs), ['2.31.0', '2.31.0', '2.31.0', '2.31.0']);
});

// rt199: `vm update agente`
function agentMachine({ same = false, inProcessChanged = true, installCode = 0, shutdown = 'inactive', systemdRunCode = 0 } = {}) {
  const calls = [];
  const writes = [];
  const files = {
    '/data/collab-runtime/agent/collab-sites-agent.mjs': 'new-agent',
    '/usr/local/lib/collab-sites-agent/collab-sites-agent.mjs': same ? 'new-agent' : (inProcessChanged ? 'old-agent' : 'new-agent'),
    '/data/collab-runtime/scripts/pm2-lifecycle.mjs': 'new-life',
    '/usr/local/lib/collab/pm2-lifecycle.mjs': same ? 'new-life' : 'old-life',
    '/data/collab-runtime/scripts/install-shutdown.sh': '#!/bin/bash',
    '/data/etc/shared.json': '{"projetoPrincipal":102047}',
    '/data/app102047/mls-base/scripts/runtime/releaseRecord.mjs': '',
  };
  const run = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (command === 'bash') return { code: installCode, out: '', err: installCode ? 'copy failed\n' : '' };
    if (command === 'systemctl' && args[0] === 'is-active') return { code: 0, out: `${shutdown}\n`, err: '' };
    if (command === 'systemd-run') return { code: systemdRunCode, out: '', err: '' };
    if (command === 'systemctl' && args[0] === 'restart') return { code: 0, out: '', err: '' };
    if (command === 'node') return { code: 0, out: 'recorded vm x ok\n', err: '' };
    return { code: 127, out: '', err: 'unexpected' };
  };
  return {
    calls, writes,
    deps: {
      run, env: { COLLAB_ETC_DIR: '/data/etc' }, now: () => 1_700_000_000_000,
      exists: (p) => p in files, readText: (p) => files[p], hashOf: (p) => files[p], listDir: () => ['app102047'],
      write: (t) => writes.push(t),
    },
  };
}
const recordCall = (m) => m.calls.find((line) => line.startsWith('node ') && line.includes(' vm '));

test('agente: hash igual em tudo não instala, não grava e não reinicia', async () => {
  const m = agentMachine({ same: true });
  const result = await updateAgent({ ...m.deps });
  assert.equal(result.nothing, true);
  assert.equal(result.ok, true);
  assert.deepEqual(m.calls, []);
  assert.match(m.writes.join(''), /nada a fazer/u);
});

test('agente: hash diferente instala com o install-shutdown.sh, grava o registro e SÓ DEPOIS reinicia (por último, fora do processo)', async () => {
  const m = agentMachine();
  const result = await updateAgent({ ...m.deps });
  assert.equal(result.ok, true);
  assert.equal(result.reinicio, true);
  const installAt = m.calls.findIndex((line) => line === 'bash /data/collab-runtime/scripts/install-shutdown.sh --maintenance-only');
  const recordAt = m.calls.findIndex((line) => line.startsWith('node ') && line.includes(' vm '));
  const restartAt = m.calls.findIndex((line) => line.startsWith('systemd-run '));
  assert.ok(installAt >= 0 && installAt < recordAt && recordAt < restartAt, `ordem: ${m.calls.join(' | ')}`);
  assert.equal(m.calls.at(-1).startsWith('systemd-run --on-active=2s'), true, 'o reinício é o último comando');
  assert.match(m.calls[restartAt], /systemctl restart collab-sites-agent$/u);
  assert.ok(!m.calls.includes('systemctl restart collab-sites-agent'), 'sem reinício direto dentro do processo');
  const args = recordCall(m).split(' ');
  assert.equal(args[args.indexOf('--passos') + 1], 'agente,restart-agente');
  assert.equal(args[args.indexOf('--resultado') + 1], 'ok');
});

test('agente: só arquivo que não roda dentro do agente mudou = instala e grava, sem reiniciar', async () => {
  const m = agentMachine({ inProcessChanged: false });
  const result = await updateAgent({ ...m.deps });
  assert.equal(result.ok, true);
  assert.equal(result.reinicio, false);
  assert.ok(m.calls.some((line) => line.startsWith('bash ')));
  assert.ok(!m.calls.some((line) => line.startsWith('systemd-run') || line.includes('restart')));
  const args = recordCall(m).split(' ');
  assert.equal(args[args.indexOf('--passos') + 1], 'agente');
});

test('agente --dry-run só lista: não instala, não grava, não reinicia', async () => {
  const m = agentMachine();
  const result = await updateAgent({ dryRun: true, ...m.deps });
  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);
  assert.deepEqual(m.calls, []);
  assert.match(m.writes.join(''), /--dry-run: instalaria pelo install-shutdown\.sh --maintenance-only e reiniciaria o collab-sites-agent por último/u);
});

test('agente: instalação que falha registra falhou, não reinicia e devolve ok:false', async () => {
  const m = agentMachine({ installCode: 1 });
  const result = await updateAgent({ ...m.deps });
  assert.equal(result.ok, false);
  assert.equal(result.falha.passo, 'agente');
  assert.match(result.falha.mensagem, /install-shutdown\.sh: copy failed/u);
  assert.ok(!m.calls.some((line) => line.startsWith('systemd-run')));
  const args = recordCall(m).split(' ');
  assert.equal(args[args.indexOf('--resultado') + 1], 'falhou');
});

test('agente --no-record --no-restart (usado pelo update-collab-runtime.sh): instala e avisa o reinício, sem gravar nem reiniciar', async () => {
  const m = agentMachine();
  const result = await updateAgent({ record: false, restart: false, ...m.deps });
  assert.equal(result.ok, true);
  assert.equal(result.reinicio, true, 'diz que precisa reiniciar, quem reinicia é o script, depois do registro dele');
  assert.ok(m.calls.some((line) => line.startsWith('bash ')));
  assert.equal(recordCall(m), undefined);
  assert.ok(!m.calls.some((line) => line.startsWith('systemd-run')));
});

test('restartAgent: desligamento ordenado em curso adia; systemd-run que falha cai no reinício direto, com aviso', async () => {
  const busy = agentMachine({ shutdown: 'active' });
  const deferred = await restartAgent({ ...busy.deps });
  assert.deepEqual(deferred, { scheduled: false, deferred: true });
  assert.ok(!busy.calls.some((line) => line.startsWith('systemd-run') || line.includes('restart')));
  const noTimer = agentMachine({ systemdRunCode: 1 });
  const direct = await restartAgent({ ...noTimer.deps });
  assert.equal(direct.scheduled, true);
  assert.equal(direct.direct, true);
  assert.ok(noTimer.calls.includes('systemctl restart collab-sites-agent'));
  assert.match(noTimer.writes.join(''), /\[WARN\] systemd-run falhou/u);
});
