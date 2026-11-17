import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ensureDbBlock, parseDbArgs } from "./msg-cm-db.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "msg-cm-db.mjs");
const PASSWORD = "pw-do-not-print-0123456789abcdef";

function fixture(appconfig) {
  const dir = mkdtempSync(join(tmpdir(), "cm-db-"));
  const config = join(dir, "appconfig.json");
  const pass = join(dir, "postgres-cm.pass");
  writeFileSync(config, `${JSON.stringify(appconfig, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(pass, `${PASSWORD}\n`, { mode: 0o600 });
  return { dir, config, pass };
}

const BASE = { hook: { collabtoken: "keep" }, redis: { host: "127.0.0.1", port: 6379 }, storage: { s3Region: "us-east-1" } };

test("cria o bloco db quando falta e preserva as outras chaves, em 0600", () => {
  const box = fixture(BASE);
  try {
    const result = ensureDbBlock({ ...parseDbArgs(["--appconfig", box.config, "--password-file", box.pass]) });
    assert.deepEqual(result, { action: "created", keys: ["host", "port", "database", "user", "password"] });
    const written = JSON.parse(readFileSync(box.config, "utf8"));
    assert.deepEqual(written.db, { host: "127.0.0.1", port: 5432, database: "cm", user: "cm", password: PASSWORD });
    assert.deepEqual({ ...written, db: undefined }, { ...BASE, db: undefined });
    assert.equal(statSync(box.config).mode & 0o777, 0o600);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("bloco db existente fica como está, qualquer que seja o conteúdo", () => {
  for (const db of [{ databaseUrl: "postgres://x@y/z" }, { host: "h", password: "other" }, {}]) {
    const box = fixture({ ...BASE, db });
    try {
      const before = readFileSync(box.config, "utf8");
      const result = ensureDbBlock(parseDbArgs(["--appconfig", box.config, "--password-file", box.pass]));
      assert.deepEqual(result, { action: "kept", keys: [] });
      assert.equal(readFileSync(box.config, "utf8"), before);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }
});

test("a saída do comando diz a ação e os nomes das chaves, nunca a senha", () => {
  const box = fixture(BASE);
  try {
    const run = () => spawnSync("node", [SCRIPT, "--appconfig", box.config, "--password-file", box.pass, "--database", "cm2"], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "db created keys=host,port,database,user,password\n");
    assert.equal(JSON.parse(readFileSync(box.config, "utf8")).db.database, "cm2");
    const second = run();
    assert.equal(second.stdout, "db kept\n");
    for (const out of [first, second]) {
      assert.equal(out.stdout.includes(PASSWORD) || out.stderr.includes(PASSWORD), false);
    }
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("sem arquivo de senha, sem appconfig ou com JSON quebrado é erro sem gravar e sem a senha", () => {
  const box = fixture(BASE);
  try {
    const before = readFileSync(box.config, "utf8");
    assert.throws(() => ensureDbBlock({ ...parseDbArgs(["--appconfig", box.config, "--password-file", join(box.dir, "absent")]) }), /password file is missing or empty/);
    writeFileSync(box.pass, "\n");
    assert.throws(() => ensureDbBlock(parseDbArgs(["--appconfig", box.config, "--password-file", box.pass])), /missing or empty/);
    assert.equal(readFileSync(box.config, "utf8"), before);
    assert.throws(() => ensureDbBlock(parseDbArgs(["--appconfig", join(box.dir, "none.json"), "--password-file", box.pass])), /appconfig\.json not found/);
    writeFileSync(box.config, "{oops");
    chmodSync(box.config, 0o600);
    assert.throws(() => ensureDbBlock(parseDbArgs(["--appconfig", box.config, "--password-file", box.pass])), /not JSON/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("argumentos obrigatórios e desconhecidos", () => {
  assert.throws(() => parseDbArgs([]), /--appconfig is required/);
  assert.throws(() => parseDbArgs(["--appconfig", "a"]), /--password-file is required/);
  assert.throws(() => parseDbArgs(["--appconfig", "a", "--password-file", "b", "--x"]), /unknown argument/);
  assert.throws(() => parseDbArgs(["--appconfig", "a", "--password-file", "b", "--port", "zero"]), /--port/);
});
