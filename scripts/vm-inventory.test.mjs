import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENT_IDS, buildInventory, formatInventory } from './vm-inventory.mjs';

// A fake machine: `answers` maps "command arg arg…" prefixes to { code, out, err }; the first matching prefix wins.
function machine(answers = {}, files = {}) {
  const calls = [];
  const run = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    for (const [prefix, answer] of Object.entries(answers)) {
      if (line.startsWith(prefix) || line.includes(prefix)) {
        return typeof answer === 'function' ? answer(line) : { code: 0, out: '', err: '', ...answer };
      }
    }
    return { code: 127, out: '', err: `not found: ${command}` };
  };
  return {
    calls,
    deps: {
      run,
      env: { COLLAB_RUNTIME_DIR: '/data/collab-runtime', COLLAB_SYSTEMD_DIR: '/etc/systemd/system' },
      exists: (path) => path in files,
      readText: (path) => files[path],
      hashOf: (path) => files[path],
      listDir: (path) => Object.keys(files).filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1).split('/')[0]).filter((v, i, a) => a.indexOf(v) === i),
      now: (() => { let t = 1_000; return () => (t += 7); })(),
      vmId: () => 'srv_test',
    },
  };
}

const DBS = 'template1\ncollab_a\ncollab_b\ncollab_c\n';
const FULL = {
  'git -c safe.directory=* -C /data/collab-runtime rev-parse': { out: 'b5e586b\n' },
  'sh -c command -v pm2': { out: '' },
  'dpkg-query': { out: 'timescaledb-2-postgresql-17|2.31.0~ubuntu24.04-1700\n' },
  'select datname': { out: DBS },
  "select extversion": (line) => ({ code: 0, out: line.includes('collab_a') ? '2.31.0\n' : '2.30.0\n', err: '' }),
  'current_setting': { out: '17.9 (Ubuntu 17.9-1)|40|20|8\n' },
  'nginx -v': { err: 'nginx version: nginx/1.24.0 (Ubuntu)\n' },
  'node --version': { out: 'v22.11.0\n' },
  'deno --version': { out: 'deno 2.1.4 (stable, release, aarch64-unknown-linux-gnu)\nv8 13.0\n' },
  'redis-server --version': { out: 'Redis server v=7.0.15 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=x\n' },
  'apt-get -s upgrade': { out: 'Reading package lists...\nInst libssl3 [3.0.1] (3.0.2 Ubuntu)\nInst curl [8.1] (8.2 Ubuntu)\nConf curl (8.2 Ubuntu)\n' },
  'df -Pk': { out: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 20971520 8388608 12582912 40% /\n/dev/b 41943040 16777216 25165824 40% /data\n' },
};
const FILES = {
  '/usr/local/lib/collab-sites-agent/collab-sites-agent.mjs': 'aaaaaaaaaaaa',
  '/data/collab-runtime/agent/collab-sites-agent.mjs': 'aaaaaaaaaaaa',
  '/usr/lib/node_modules/pm2/package.json': JSON.stringify({ version: '5.4.3' }),
  '/etc/systemd/system/pm2-ubuntu.service.d/fixed-configs.conf': '[Service]\nExecStart=/usr/bin/pm2 resurrect "/data/etc/pm2.apps.config.js"\n',
};
const byId = (inventory, id) => inventory.componentes.find((c) => c.id === id);

test('o documento segue o contrato vm-inventory v1 e traz todos os componentes', async () => {
  const { deps } = machine(FULL, FILES);
  const inventory = await buildInventory(deps);
  assert.equal(inventory.versaoContrato, 1);
  assert.equal(inventory.vmId, 'srv_test');
  assert.match(inventory.geradoEm, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(typeof inventory.duracaoMs, 'number');
  assert.deepEqual(inventory.componentes.map((c) => c.id), COMPONENT_IDS);
  assert.deepEqual(COMPONENT_IDS, ['collab-runtime', 'agente', 'pm2', 'postgres', 'timescaledb', 'nginx', 'node', 'deno', 'redis', 'sistema', 'disco']);
  for (const component of inventory.componentes) {
    assert.ok(['ok', 'desatualizado', 'erro'].includes(component.estado), `${component.id}: ${component.estado}`);
    assert.equal(typeof component.instalado, 'string');
  }
});

test('versões: runtime, nginx, node, deno, redis, postgres, pm2', async () => {
  const inventory = await buildInventory(machine(FULL, FILES).deps);
  assert.equal(byId(inventory, 'collab-runtime').instalado, 'b5e586b');
  assert.equal(byId(inventory, 'nginx').instalado, '1.24.0');
  assert.equal(byId(inventory, 'node').instalado, '22.11.0');
  assert.equal(byId(inventory, 'deno').instalado, '2.1.4');
  assert.equal(byId(inventory, 'redis').instalado, '7.0.15');
  const postgres = byId(inventory, 'postgres');
  assert.equal(postgres.instalado, '17.9');
  assert.match(postgres.detalhe, /max_worker_processes=40 timescaledb\.max_background_workers=20 max_parallel_workers=8/u);
  const pm2 = byId(inventory, 'pm2');
  assert.equal(pm2.instalado, '5.4.3');
  assert.match(pm2.detalhe, /\/data\/etc\/pm2\.apps\.config\.js/u);
});

test('timescaledb: pacote 2.31 × extensão 2.30 em três bancos (com o template1) = desatualizado, com a ação e o reinício', async () => {
  const timescale = byId(await buildInventory(machine(FULL, FILES).deps), 'timescaledb');
  assert.equal(timescale.instalado, '2.31.0');
  assert.equal(timescale.estado, 'desatualizado');
  assert.equal(timescale.acao, 'timescaledb');
  assert.equal(timescale.exigeReinicio, true);
  assert.match(timescale.detalhe, /extensão 2\.30\.0: 3 banco\(s\) \(template1 \(modelo dos rascunhos\), collab_b, collab_c\)/u);
});

test('timescaledb: o template1 atrasado aparece como modelo dos rascunhos e a consulta o inclui', async () => {
  const { deps, calls } = machine({ ...FULL, 'select extversion': (line) => ({ code: 0, out: line.includes('template1') ? '2.30.0\n' : '2.31.0\n', err: '' }) }, FILES);
  const timescale = byId(await buildInventory(deps), 'timescaledb');
  assert.equal(timescale.estado, 'desatualizado');
  assert.match(timescale.detalhe, /template1 \(modelo dos rascunhos\)/u);
  assert.ok(calls.some((line) => line.includes("select datname") && !line.includes('not datistemplate')), 'a consulta não exclui os modelos');
});

test('timescaledb: tudo igual ao pacote = ok, sem ação', async () => {
  const timescale = byId(await buildInventory(machine({ ...FULL, 'select extversion': { out: '2.31.0\n' } }, FILES).deps), 'timescaledb');
  assert.equal(timescale.estado, 'ok');
  assert.equal(timescale.acao, undefined);
});

test('agente: cópia igual ao checkout = ok; diferente = desatualizado', async () => {
  assert.equal(byId(await buildInventory(machine(FULL, FILES).deps), 'agente').estado, 'ok');
  const files = { ...FILES, '/data/collab-runtime/agent/collab-sites-agent.mjs': 'bbbbbbbbbbbb' };
  const agente = byId(await buildInventory(machine(FULL, files).deps), 'agente');
  assert.equal(agente.estado, 'desatualizado');
  assert.equal(agente.instalado, 'aaaaaaaaaaaa');
  assert.match(agente.detalhe, /checkout bbbbbbbbbbbb/u);
});

test('sistema: conta os pacotes do cache do apt (sem apt update) e vê o reboot pedido', async () => {
  const { deps, calls } = machine(FULL, { ...FILES, '/var/run/reboot-required': '' });
  const sistema = byId(await buildInventory(deps), 'sistema');
  assert.equal(sistema.instalado, '2 pacote(s) a atualizar');
  assert.equal(sistema.estado, 'desatualizado');
  assert.equal(sistema.exigeReinicio, true);
  assert.match(sistema.detalhe, /reboot pedido/u);
  assert.ok(calls.some((line) => line === 'apt-get -s upgrade'));
  assert.ok(!calls.some((line) => /apt(-get)? update/u.test(line)), 'não pode rodar apt update');
});

test('disco: uso de / e /data', async () => {
  const disco = byId(await buildInventory(machine(FULL, FILES).deps), 'disco');
  assert.equal(disco.instalado, '/ 40% · /data 40%');
  assert.match(disco.detalhe, /\/data: 16\.0 de 40\.0 GB/u);
});

test('leitura que falha vira erro com detalhe e não derruba as outras', async () => {
  const inventory = await buildInventory(machine({ ...FULL, 'nginx -v': { code: 127, out: '', err: 'nginx: not found' }, 'node --version': () => { throw new Error('boom'); } }, FILES).deps);
  assert.equal(byId(inventory, 'nginx').estado, 'erro');
  assert.match(byId(inventory, 'nginx').detalhe, /nginx -v/u);
  assert.equal(byId(inventory, 'node').estado, 'erro');
  assert.match(byId(inventory, 'node').detalhe, /boom/u);
  assert.equal(byId(inventory, 'redis').estado, 'ok');
  assert.equal(inventory.componentes.length, COMPONENT_IDS.length);
});

test('uma leitura que não responde vira erro no prazo, sem segurar o total', async () => {
  const { deps } = machine({ ...FULL, 'nginx -v': () => new Promise(() => {}) }, FILES);
  const inventory = await buildInventory({ ...deps, timeoutMs: 50 });
  assert.equal(byId(inventory, 'nginx').estado, 'erro');
  assert.match(byId(inventory, 'nginx').detalhe, /sem resposta em 50 ms/u);
  assert.equal(byId(inventory, 'node').estado, 'ok');
});

test('a saída termina na linha do JSON do contrato, sem segredo', async () => {
  const text = formatInventory(await buildInventory(machine(FULL, FILES).deps));
  const lines = text.trimEnd().split('\n');
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(parsed.versaoContrato, 1);
  assert.equal(parsed.componentes.length, COMPONENT_IDS.length);
  assert.ok(lines.length > 1, 'uma linha legível por componente antes do JSON');
  assert.ok(!/password|secret|token|DATABASE_URL/iu.test(text));
});

test('só lê: nenhum comando de escrita ou de rede', async () => {
  const { deps, calls } = machine(FULL, FILES);
  await buildInventory(deps);
  for (const line of calls) {
    assert.ok(!/\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/u.test(line.replace(/'timescaledb'/gu, '')), `escrita: ${line}`);
    assert.ok(!/\b(curl|wget|restart|reload|install)\b/u.test(line), `ação: ${line}`);
  }
});
