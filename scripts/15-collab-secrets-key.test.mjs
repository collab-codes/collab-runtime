import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = join(root, "scripts/15-collab-secrets-key.sh");
const installSh = readFileSync(join(root, "install.sh"), "utf8");

function box() {
  const dir = mkdtempSync(join(tmpdir(), "step15-"));
  const data = join(dir, "data");
  mkdirSync(join(data, "app102047", "mls-base"), { recursive: true });
  mkdirSync(join(data, "mls-base"), { recursive: true });
  writeFileSync(join(data, "app102047", "mls-base", ".env"), "APP_ENV=production\nPGHOST=127.0.0.1\n");
  writeFileSync(join(data, "mls-base", ".env"), "APP_ENV=production\nCOLLAB_SECRETS_KEY_FILE=/old\n");
  const run = (...args) => spawnSync("bash", [step, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      COLLAB_DATA_ROOT: data,
      COLLAB_DEPLOY_USER: process.env.USER || "root",
    },
  });
  return {
    dir,
    data,
    key: join(data, "etc", "collab-secrets.key"),
    appEnv: join(data, "app102047", "mls-base", ".env"),
    sharedEnv: join(data, "mls-base", ".env"),
    run,
  };
}

test("primeira rodada: 32 bytes, modo 600, dono o usuário de deploy, caminho no .env; os bytes não saem no log", () => {
  const b = box();
  try {
    const result = b.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const key = readFileSync(b.key);
    assert.equal(key.length, 32);
    assert.equal(statSync(b.key).mode & 0o777, 0o600);
    assert.equal(statSync(b.key).uid, process.getuid());
    assert.equal(readFileSync(b.appEnv, "utf8").includes(`COLLAB_SECRETS_KEY_FILE=${b.key}`), true);
    assert.match(readFileSync(b.sharedEnv, "utf8"), new RegExp(`^COLLAB_SECRETS_KEY_FILE=${b.key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`, "m"));
    assert.equal(readFileSync(b.appEnv, "utf8").includes("PGHOST=127.0.0.1"), true);
    assert.equal(result.stdout.includes(key.toString("hex")), false);
    assert.equal(result.stderr.includes(key.toString("hex")), false);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("segunda rodada não troca a chave e não reescreve um .env que já aponta para ela", () => {
  const b = box();
  try {
    assert.equal(b.run().status, 0);
    const key = readFileSync(b.key);
    const app = readFileSync(b.appEnv, "utf8");
    const second = b.run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(b.key), key);
    assert.equal(readFileSync(b.appEnv, "utf8"), app);
    assert.match(second.stdout, /already right/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("arquivo com tamanho errado não é substituído", () => {
  const b = box();
  try {
    mkdirSync(join(b.data, "etc"), { recursive: true });
    writeFileSync(b.key, Buffer.from("short"));
    const result = b.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(b.key, "utf8"), "short");
    assert.match(result.stdout, /left untouched/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("argumento nomeia um .env; os outros ficam", () => {
  const b = box();
  try {
    const only = join(b.dir, "one.env");
    writeFileSync(only, "APP_ENV=production\n");
    const before = readFileSync(b.appEnv, "utf8");
    const result = b.run(only, join(b.dir, "missing.env"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(only, "utf8"), /^COLLAB_SECRETS_KEY_FILE=/m);
    assert.equal(readFileSync(b.appEnv, "utf8"), before);
    assert.match(result.stdout, /not found — skipped/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("sem .env: a chave nasce e o passo avisa", () => {
  const b = box();
  try {
    rmSync(b.appEnv);
    rmSync(b.sharedEnv);
    const result = b.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(b.key), true);
    assert.equal(statSync(b.key).size, 32);
    assert.match(result.stdout, /no app \.env found/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("install.sh roda o passo 15 depois do papel somente-leitura", () => {
  const at13 = installSh.indexOf('"13-postgres-readonly.sh"');
  const at15 = installSh.indexOf('"15-collab-secrets-key.sh"');
  assert.ok(at13 > 0 && at15 > at13, "15 runs after 13");
});

test("o script é bash válido", () => {
  const check = spawnSync("bash", ["-n", step], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
