import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step13 = join(root, "scripts/13-postgres-readonly.sh");
const installSh = readFileSync(join(root, "install.sh"), "utf8");

// `sudo -u postgres psql …` becomes a stub that records what it received (arguments and stdin) and answers the two
// existence queries from flag files, so the script runs without a Postgres (rt205 s1; the real proof is the lima's).
function sandbox({ roleExists = false, dbExists = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ro-role-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // sudo -u postgres psql … -> drop "-u postgres" and run psql
  writeFileSync(join(bin, "sudo"), `#!/bin/bash\nif [[ "$1" == "-u" ]]; then shift 2; fi\nexec "$@"\n`);
  writeFileSync(
    join(bin, "psql"),
    `#!/bin/bash
echo "$*" >> "${dir}/psql.args"
if [[ " $* " == *" -tAc "* ]]; then
  q="$*"
  if [[ "$q" == *pg_roles* && -e "${dir}/role_exists" ]]; then echo 1; fi
  if [[ "$q" == *pg_database* && -e "${dir}/db_exists" ]]; then echo 1; fi
  exit 0
fi
cat >> "${dir}/psql.stdin"
if grep -q "CREATE ROLE" "${dir}/psql.stdin"; then touch "${dir}/role_exists"; fi
exit 0
`,
  );
  chmodSync(join(bin, "sudo"), 0o755);
  chmodSync(join(bin, "psql"), 0o755);
  if (roleExists) writeFileSync(join(dir, "role_exists"), "");
  if (dbExists) writeFileSync(join(dir, "db_exists"), "");
  mkdirSync(join(dir, "data", "app102047", "mls-base"), { recursive: true });
  mkdirSync(join(dir, "data", "app102056", "mls-base"), { recursive: true });
  writeFileSync(join(dir, "data", "app102047", "mls-base", ".env"), "PGHOST=127.0.0.1\nPGPORT=5432\nPGDATABASE=mdm\nPGUSER=collab\nPGPASSWORD=collab\n");
  writeFileSync(join(dir, "data", "app102056", "mls-base", ".env"), "PGDATABASE=mdm\nDATABASE_URL_READONLY=postgres://old\n");
  const run = (...args) =>
    spawnSync("bash", [step13, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COLLAB_DATA_ROOT: join(dir, "data"),
        LOG_DIR: join(dir, "logs"),
        SUMMARY_LOG: join(dir, "summary.log"),
        DETAIL_LOG: join(dir, "detail.log"),
      },
    });
  return { dir, run, read: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "") };
}

function urlOf(file) {
  return /^DATABASE_URL_READONLY=(.*)$/mu.exec(readFileSync(file, "utf8"))?.[1];
}

test("13 creates a read-only role, grants SELECT in the app database, and writes the URL into each app .env", () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const sql = s.read("psql.stdin");
  assert.match(sql, /CREATE ROLE "collab_readonly" WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '[0-9a-f]{48}'/u);
  assert.match(sql, /GRANT CONNECT ON DATABASE "collab_app_test" TO "collab_readonly"/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO "collab_readonly"/u);
  assert.match(sql, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO "collab_readonly"/u);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE "collab" IN SCHEMA public GRANT SELECT ON TABLES TO "collab_readonly"/u);
  // never write permission, never membership of the app role
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL|TRUNCATE)\b/iu);
  assert.doesNotMatch(sql, /GRANT "?collab"? TO/u);
  const grantsDb = s.read("psql.args");
  assert.match(grantsDb, /-d collab_app_test/u);
  for (const app of ["app102047", "app102056"]) {
    const url = urlOf(join(s.dir, "data", app, "mls-base", ".env"));
    assert.match(url, /^postgres:\/\/collab_readonly:[0-9a-f]{48}@127\.0\.0\.1:5432\/collab_app_test$/u);
  }
  // the other keys of the .env stay, and the old line is replaced, not duplicated
  const env102056 = readFileSync(join(s.dir, "data", "app102056", "mls-base", ".env"), "utf8");
  assert.match(env102056, /^PGDATABASE=mdm$/mu);
  assert.equal((env102056.match(/^DATABASE_URL_READONLY=/gmu) ?? []).length, 1);
});

test("13 keeps the password out of the arguments, the output and the logs; the file is root-only", () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const pass = readFileSync(join(s.dir, "data", "etc", "postgres-readonly.pass"), "utf8").trim();
  assert.match(pass, /^[0-9a-f]{48}$/u);
  assert.equal((statSync(join(s.dir, "data", "etc", "postgres-readonly.pass")).mode & 0o777).toString(8), "600");
  for (const text of [r.stdout, r.stderr, s.read("psql.args"), s.read("summary.log"), s.read("detail.log")]) {
    assert.equal(text.includes(pass), false, "the password must not appear outside the file, the SQL on stdin and the .env");
  }
});

test("13 is idempotent: a second run reuses the password and leaves the .env alone", () => {
  const s = sandbox();
  assert.equal(s.run().status, 0);
  const before = readFileSync(join(s.dir, "data", "etc", "postgres-readonly.pass"), "utf8");
  const envBefore = readFileSync(join(s.dir, "data", "app102047", "mls-base", ".env"), "utf8");
  const second = s.run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.equal(readFileSync(join(s.dir, "data", "etc", "postgres-readonly.pass"), "utf8"), before);
  assert.equal(readFileSync(join(s.dir, "data", "app102047", "mls-base", ".env"), "utf8"), envBefore);
  assert.match(s.read("psql.stdin"), /ALTER ROLE "collab_readonly" WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB/u);
  assert.match(second.stdout, /ALTER|already right/u);
});

test("13 does not touch the password of the app role", () => {
  const s = sandbox({ roleExists: true });
  assert.equal(s.run().status, 0);
  assert.doesNotMatch(s.read("psql.stdin"), /(ALTER|CREATE) ROLE "collab"( |;)/u);
});

test("13 without the database yet: warns, makes the role and the URL, grants nothing", () => {
  const s = sandbox({ dbExists: false });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, /does not exist yet/u);
  assert.doesNotMatch(s.read("psql.stdin"), /GRANT/u);
  assert.match(urlOf(join(s.dir, "data", "app102047", "mls-base", ".env")), /collab_readonly/u);
});

test("13 takes explicit .env paths and skips a missing one", () => {
  const s = sandbox();
  const only = join(s.dir, "data", "app102056", "mls-base", ".env");
  const r = s.run(only, join(s.dir, "nope", ".env"));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(urlOf(only));
  assert.equal(urlOf(join(s.dir, "data", "app102047", "mls-base", ".env")), undefined, "the other app .env was not asked for");
  assert.match(r.stdout + r.stderr, /not found — skipped/u);
});

test("install.sh runs step 13 after the project step", () => {
  const at12 = installSh.indexOf('"12-mls-project.sh"');
  const at13 = installSh.indexOf('"13-postgres-readonly.sh"');
  assert.ok(at12 > 0 && at13 > at12, "13 runs after 12");
});
