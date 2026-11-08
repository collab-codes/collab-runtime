import test from 'node:test';
import assert from 'node:assert/strict';
import { findReleaseRecordScript, updateTimescale } from './vm-update.mjs';

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
