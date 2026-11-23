import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  LOCK_STALE_MS,
  acquireLock,
  cleanTree,
  findTrees,
  isDue,
  lastFile,
  main,
  parseHours,
  readLast,
  runCleanup,
} from "./disk-cleanup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-24T02:00:00Z");

function dirs() {
  const base = mkdtempSync(join(tmpdir(), "rt304-"));
  const etc = join(base, "etc");
  mkdirSync(etc, { recursive: true });
  return { base, etc };
}

function writeLast(etc, finishedHoursAgo) {
  mkdirSync(join(etc, "disk-cleanup"), { recursive: true });
  writeFileSync(lastFile(etc), JSON.stringify({ finishedAt: new Date(NOW - finishedHoursAgo * HOUR).toISOString(), ok: true }));
}

const DISKS = [{ path: "/data", sizeKb: 100, usedKb: 80, availKb: 20, usedPercent: 80 }];

test("parseHours aceita Nh e recusa o resto", () => {
  assert.equal(parseHours("30h"), 30 * HOUR);
  assert.equal(parseHours("0h"), 0);
  for (const bad of ["30", "h", "30m", "1.5h", "", undefined]) assert.equal(parseHours(bad), null);
});

test("isDue: sem arquivo roda, 29 h não roda, 31 h roda", () => {
  assert.equal(isDue(null, NOW, 30 * HOUR), true);
  assert.equal(isDue({ finishedAt: new Date(NOW - 29 * HOUR).toISOString() }, NOW, 30 * HOUR), false);
  assert.equal(isDue({ finishedAt: new Date(NOW - 31 * HOUR).toISOString() }, NOW, 30 * HOUR), true);
  assert.equal(isDue({ finishedAt: "lixo" }, NOW, 30 * HOUR), true);
});

test("com --if-last-older-than: sem last.json roda, com 29 h não roda e nada é gravado, com 31 h roda", () => {
  const { etc, base } = dirs();
  const deps = { now: () => NOW, exec: () => ({ status: 0, stdout: "{}" }), disks: () => DISKS, trees: () => [] };
  const first = runCleanup({ dataRoot: base, etcDir: etc, trigger: "boot", minAgeMs: 30 * HOUR, deps });
  assert.equal(first.ran, true);
  writeLast(etc, 29);
  const before = readFileSync(lastFile(etc), "utf8");
  const skipped = runCleanup({ dataRoot: base, etcDir: etc, trigger: "boot", minAgeMs: 30 * HOUR, deps });
  assert.deepEqual(skipped, { ran: false, reason: "ultima limpeza recente" });
  assert.equal(readFileSync(lastFile(etc), "utf8"), before);
  writeLast(etc, 31);
  assert.equal(runCleanup({ dataRoot: base, etcDir: etc, trigger: "boot", minAgeMs: 30 * HOUR, deps }).ran, true);
});

test("sem --if-last-older-than (02:00) roda sempre, mesmo com limpeza de 1 h atrás", () => {
  const { etc, base } = dirs();
  writeLast(etc, 1);
  const outcome = runCleanup({ dataRoot: base, etcDir: etc, trigger: "timer", minAgeMs: null, deps: { now: () => NOW, disks: () => DISKS, trees: () => [] } });
  assert.equal(outcome.ran, true);
  assert.equal(outcome.record.trigger, "timer");
});

test("a trava: uma segunda execução sai sem rodar; trava velha (mais de 2 h) é retomada", () => {
  const { etc, base } = dirs();
  const release = acquireLock(etc, NOW);
  assert.equal(typeof release, "function");
  assert.equal(acquireLock(etc, NOW + 60_000), null);
  let called = 0;
  const deps = { now: () => NOW + 60_000, disks: () => DISKS, trees: () => { called += 1; return []; } };
  assert.deepEqual(runCleanup({ dataRoot: base, etcDir: etc, deps }), { ran: false, reason: "ja esta rodando" });
  assert.equal(called, 0);
  assert.equal(existsSync(lastFile(etc)), false);
  const stale = acquireLock(etc, NOW + LOCK_STALE_MS + 1);
  assert.equal(typeof stale, "function");
  stale();
  assert.equal(existsSync(join(etc, "disk-cleanup", "lock")), false);
  release();
});

test("a trava é solta ao fim (e mesmo se uma árvore estoura), e uma segunda execução roda depois", () => {
  const { etc, base } = dirs();
  const deps = { now: () => NOW, disks: () => DISKS, trees: () => ["/x/app1/mls-base"], exec: () => { throw new Error("boom"); }, exists: () => true };
  assert.throws(() => runCleanup({ dataRoot: base, etcDir: etc, deps }), /boom/u);
  assert.equal(existsSync(join(etc, "disk-cleanup", "lock")), false);
});

test("orquestração com executor falso: uma árvore falha, a outra segue, e o last.json tem a forma pedida", () => {
  const { etc, base } = dirs();
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (args[0].includes("app1")) return { status: 3, stdout: "", stderr: "disco cheio\nerro final" };
    return { status: 0, stdout: `${JSON.stringify({ root: "r", removed: [{ path: "a", kb: 10 }, { path: "b", kb: 5 }], freedKb: 15 })}\n` };
  };
  const disksReads = [DISKS, [{ ...DISKS[0], usedKb: 79, availKb: 21, usedPercent: 79 }]];
  const outcome = runCleanup({
    dataRoot: base,
    etcDir: etc,
    trigger: "timer",
    deps: {
      now: () => NOW,
      exec,
      exists: () => true,
      disks: () => disksReads.shift(),
      trees: () => ["/data/app1/mls-base", "/data/app2/mls-base"],
    },
  });
  assert.equal(outcome.ran, true);
  assert.deepEqual(calls.map((call) => call[3]), ["/data/app1/mls-base", "/data/app2/mls-base"]);
  assert.deepEqual(calls[0].slice(0, 2), ["node", "/data/app1/mls-base/scripts/runtime/pruneBuildCache.mjs"]);
  const last = JSON.parse(readFileSync(lastFile(etc), "utf8"));
  assert.deepEqual(Object.keys(last), ["startedAt", "finishedAt", "ok", "trigger", "trees", "freedKb", "disksBefore", "disksAfter"]);
  assert.equal(last.ok, false);
  assert.equal(last.trigger, "timer");
  assert.equal(last.freedKb, 15);
  assert.equal(last.trees[0].ok, false);
  assert.match(last.trees[0].error, /^exit 3: erro final/u);
  assert.deepEqual(last.trees[1], { root: "/data/app2/mls-base", ok: true, freedKb: 15, removed: 2 });
  assert.equal(last.disksBefore[0].usedPercent, 80);
  assert.equal(last.disksAfter[0].usedPercent, 79);
  assert.deepEqual(readdirSync(join(etc, "disk-cleanup")).sort(), ["last.json"]);
  assert.deepEqual(readLast(etc), last);
});

test("cleanTree: árvore sem o script é anotada como skipped, e release em andamento também", () => {
  assert.deepEqual(cleanTree("/data/app9/mls-base", () => assert.fail("não chama"), () => false), {
    root: "/data/app9/mls-base",
    ok: true,
    skipped: "sem pruneBuildCache.mjs",
    freedKb: 0,
    removed: 0,
  });
  const skipped = cleanTree("/data/app9/mls-base", () => ({ status: 0, stdout: JSON.stringify({ removed: [], freedKb: 0, skipped: "release em andamento" }) }), () => true);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, "release em andamento");
  assert.equal(cleanTree("/r", () => ({ status: 0, stdout: "não é json" }), () => true).ok, false);
});

test("findTrees lista só /data/app<id>/mls-base", () => {
  const { base } = dirs();
  for (const name of ["app102047/mls-base", "app102056/mls-base", "app7", "msg.collab.codes", "backup"]) mkdirSync(join(base, name), { recursive: true });
  assert.deepEqual(findTrees(base), [join(base, "app102047/mls-base"), join(base, "app102056/mls-base")]);
  assert.deepEqual(findTrees(join(base, "nao-existe")), []);
});

test("main: --if-last-older-than inválido sai com 2; sem execução devida sai com 0", () => {
  const { base, etc } = dirs();
  const env = { COLLAB_DATA_ROOT: base, COLLAB_ETC_DIR: etc };
  assert.equal(main(["--if-last-older-than=abc"], env), 2);
  writeLast(etc, 1);
  utimesSync(lastFile(etc), new Date(), new Date());
  const recent = JSON.parse(readFileSync(lastFile(etc), "utf8"));
  recent.finishedAt = new Date().toISOString();
  writeFileSync(lastFile(etc), JSON.stringify(recent));
  assert.equal(main(["--if-last-older-than=30h", "--trigger=boot"], env), 0);
});

test("o CLI roda ponta a ponta numa árvore de fachada e grava o last.json", () => {
  const { base, etc } = dirs();
  const tree = join(base, "app5", "mls-base");
  mkdirSync(join(tree, "scripts", "runtime"), { recursive: true });
  writeFileSync(join(tree, "scripts", "runtime", "pruneBuildCache.mjs"), 'console.log(JSON.stringify({ root: process.argv[3], removed: [{ path: "p", kb: 7 }], freedKb: 7 }));\n');
  const run = spawnSync("node", [join(root, "scripts", "disk-cleanup.mjs"), "--trigger=manual"], {
    encoding: "utf8",
    env: { ...process.env, COLLAB_DATA_ROOT: base, COLLAB_ETC_DIR: etc },
  });
  assert.equal(run.status, 0, run.stderr);
  const last = JSON.parse(readFileSync(lastFile(etc), "utf8"));
  assert.equal(last.ok, true);
  assert.equal(last.trigger, "manual");
  assert.equal(last.freedKb, 7);
  assert.equal(last.trees.length, 1);
});

function installUnits(prefix) {
  return execFileSync("bash", [join(root, "scripts/16-disk-cleanup-timers.sh")], {
    encoding: "utf8",
    env: { ...process.env, COLLAB_SYSTEMD_ROOT: prefix },
  });
}

test("16 escreve as duas unidades de timer e os dois serviços, e uma segunda execução não muda nada", () => {
  const prefix = mkdtempSync(join(tmpdir(), "rt304-units-"));
  installUnits(prefix);
  const dir = join(prefix, "etc/systemd/system");
  const daily = readFileSync(join(dir, "collab-disk-cleanup.timer"), "utf8");
  assert.match(daily, /^OnCalendar=\*-\*-\* 02:00:00 UTC$/mu);
  assert.doesNotMatch(daily, /OnBootSec/u);
  const boot = readFileSync(join(dir, "collab-disk-cleanup-boot.timer"), "utf8");
  assert.match(boot, /^OnBootSec=10min$/mu);
  assert.doesNotMatch(boot, /OnCalendar/u);
  const dailyService = readFileSync(join(dir, "collab-disk-cleanup.service"), "utf8");
  assert.match(dailyService, /^Type=oneshot$/mu);
  assert.match(dailyService, /^ExecStart=\/usr\/bin\/env node \S+\/scripts\/disk-cleanup\.mjs --trigger=timer$/mu);
  assert.doesNotMatch(dailyService, /if-last-older-than/u);
  const bootService = readFileSync(join(dir, "collab-disk-cleanup-boot.service"), "utf8");
  assert.match(bootService, /--trigger=boot --if-last-older-than=30h$/mu);
  const second = installUnits(prefix);
  assert.doesNotMatch(second, /wrote /u);
  assert.equal(readFileSync(join(dir, "collab-disk-cleanup.timer"), "utf8"), daily);
});

test("install.sh e update-collab-runtime.sh instalam o passo 16 e nada inicia o serviço de limpeza", () => {
  const install = readFileSync(join(root, "install.sh"), "utf8");
  assert.ok(install.indexOf('"16-disk-cleanup-timers.sh"') > install.indexOf('"15-collab-secrets-key.sh"'));
  const update = readFileSync(join(root, "scripts/update-collab-runtime.sh"), "utf8");
  assert.match(update, /16-disk-cleanup-timers\.sh/u);
  const unitsScript = readFileSync(join(root, "scripts/16-disk-cleanup-timers.sh"), "utf8");
  for (const text of [install, update, unitsScript]) {
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /systemctl (start|--now)[^\n]*disk-cleanup/u);
    assert.doesNotMatch(code, /enable --now[^\n]*disk-cleanup/u);
    assert.doesNotMatch(code, /systemctl[^\n]*(start|restart)[^\n]*collab-disk-cleanup(-boot)?\.service/u);
  }
  assert.doesNotMatch(unitsScript.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n"), /systemctl[^\n]*(start|restart)[^\n]*boot\.timer/u);
});
