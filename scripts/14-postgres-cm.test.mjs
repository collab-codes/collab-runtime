import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const STEP = join(SCRIPTS, "14-postgres-cm.sh");

const FAKE_PSQL = `#!/bin/bash
echo "$*" >> "$FAKE/argv.log"
args="$*"
if [[ "$args" == *"-h 127.0.0.1"* ]]; then
  if [[ -z "\${FAKE_LOGIN_FAIL:-}" && "\${PGPASSWORD:-}" == "$(cat "$FAKE/role.pass" 2>/dev/null)" ]]; then echo 1; fi
  exit 0
fi
if [[ "$args" == *"FROM pg_roles"* ]]; then [[ -f "$FAKE/role" ]] && echo 1; exit 0; fi
if [[ "$args" == *"FROM pg_database"* ]]; then [[ -f "$FAKE/db" ]] && echo 1; exit 0; fi
if [[ "$args" == *"CREATE DATABASE"* ]]; then touch "$FAKE/db"; echo "$args" > "$FAKE/createdb.log"; exit 0; fi
sql="$(cat)"
echo "$sql" >> "$FAKE/stdin.log"
touch "$FAKE/role"
echo "$sql" | sed -n "s/.*PASSWORD '\\(.*\\)';.*/\\1/p" > "$FAKE/role.pass"
`;
const FAKE_SUDO = `#!/bin/bash
if [[ "$1" == "-u" ]]; then shift 2; fi
exec "$@"
`;

function box() {
  const dir = mkdtempSync(join(tmpdir(), "step14-"));
  const bin = join(dir, "bin");
  const fake = join(dir, "fake");
  mkdirSync(bin);
  mkdirSync(fake);
  mkdirSync(join(dir, "msg", "node"), { recursive: true });
  writeFileSync(join(bin, "psql"), FAKE_PSQL);
  writeFileSync(join(bin, "sudo"), FAKE_SUDO);
  chmodSync(join(bin, "psql"), 0o755);
  chmodSync(join(bin, "sudo"), 0o755);
  const appconfig = join(dir, "msg", "node", "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify({ hook: { collabtoken: "keep" }, storage: { s3Region: "us-east-1" } }, null, 2)}\n`, { mode: 0o600 });
  const run = (extraEnv = {}) => spawnSync("bash", [STEP], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, COLLAB_DATA_ROOT: dir, COLLAB_MESSAGES_DEPLOY_ROOT: join(dir, "msg"), ...extraEnv },
  });
  return { dir, fake, appconfig, pass: join(dir, "etc", "postgres-cm.pass"), run };
}

const read = (file) => readFileSync(file, "utf8");

test("primeira rodada: papel, banco do dono, login e bloco db; a senha não aparece em saída, argumento nem log", () => {
  const b = box();
  try {
    const result = b.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const password = read(b.pass).trim();
    assert.match(password, /^[0-9a-f]{48}$/);
    assert.equal(statSync(b.pass).mode & 0o777, 0o600);
    assert.match(read(join(b.fake, "stdin.log")), /^CREATE ROLE "cm" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD /);
    assert.match(read(join(b.fake, "createdb.log")), /CREATE DATABASE "cm" OWNER "cm"/);
    const config = JSON.parse(read(b.appconfig));
    assert.deepEqual(config.db, { host: "127.0.0.1", port: 5432, database: "cm", user: "cm", password });
    assert.equal(config.hook.collabtoken, "keep");
    assert.equal(statSync(b.appconfig).mode & 0o777, 0o600);
    assert.match(result.stdout, /db created keys=host,port,database,user,password/);
    for (const text of [result.stdout, result.stderr, read(join(b.fake, "argv.log"))]) {
      assert.equal(text.includes(password), false, "a senha vazou");
    }
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("segunda rodada não muda nada: mesma senha, mesmo appconfig, db kept, papel alterado e não recriado", () => {
  const b = box();
  try {
    assert.equal(b.run().status, 0);
    const pass = read(b.pass);
    const appconfig = read(b.appconfig);
    const second = b.run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(read(b.pass), pass);
    assert.equal(read(b.appconfig), appconfig);
    assert.match(second.stdout, /db kept/);
    assert.match(read(join(b.fake, "stdin.log")), /ALTER ROLE "cm"/);
    assert.equal(read(join(b.fake, "stdin.log")).match(/CREATE ROLE/g).length, 1);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("papel existente sem o arquivo de senha: nada é mudado e nenhum bloco é gravado", () => {
  const b = box();
  try {
    writeFileSync(join(b.fake, "role"), "");
    const before = read(b.appconfig);
    const result = b.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exists but .*does not/);
    assert.equal(existsSync(join(b.fake, "stdin.log")), false);
    assert.equal(existsSync(b.pass), false);
    assert.equal(read(b.appconfig), before);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("login por TCP que falha derruba o passo antes do bloco", () => {
  const b = box();
  try {
    const before = read(b.appconfig);
    const result = b.run({ FAKE_LOGIN_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot log in on 127\.0\.0\.1/);
    assert.equal(read(b.appconfig), before);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("sem appconfig: avisa e não grava", () => {
  const b = box();
  try {
    rmSync(b.appconfig);
    const result = b.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no db block written/);
    assert.equal(existsSync(b.appconfig), false);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("o passo 11 chama o passo 14 antes de instalar a release e o instalador copia os dois arquivos", () => {
  const installer = read(join(SCRIPTS, "11-install-collab-messages.sh"));
  const call = installer.indexOf('bash "$CM_DB_STEP"');
  const release = installer.indexOf('"$ROOT/addNewVersion" --updatePackage');
  assert.ok(call > 0 && release > call, "step 14 precisa rodar antes do addNewVersion");
  assert.ok(installer.indexOf('cat > "$NODE_DIR/appconfig.json"') < call, "o appconfig básico nasce antes do bloco");
  assert.match(read(join(SCRIPTS, "install-cli.sh")), /14-postgres-cm\.sh msg-cm-db\.mjs/);
});

test("os scripts são bash válido", () => {
  for (const name of ["14-postgres-cm.sh", "11-install-collab-messages.sh"]) {
    const check = spawnSync("bash", ["-n", join(SCRIPTS, name)], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
});
