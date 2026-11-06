import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const install = readFileSync(join(root, "install.sh"), "utf8");

function run(prefix) {
  mkdirSync(join(prefix, "log"), { recursive: true });
  return execFileSync("bash", [join(root, "scripts/04b-log-retention.sh")], {
    encoding: "utf8",
    env: { ...process.env, COLLAB_RETENTION_ROOT: prefix, LOG_DIR: join(prefix, "log") },
  });
}

test("04b writes the 30-day logrotate and journald files, and a second run changes nothing", () => {
  const prefix = mkdtempSync(join(tmpdir(), "rt185-ret-"));
  run(prefix);
  const rotate = readFileSync(join(prefix, "etc/logrotate.d/postgresql-common"), "utf8");
  assert.match(rotate, /^\/var\/log\/postgresql\/\*\.log \{/m);
  assert.match(rotate, /^\s+daily$/m);
  assert.match(rotate, /^\s+rotate 30$/m);
  assert.match(rotate, /^\s+maxsize 200M$/m);
  assert.match(rotate, /^\s+copytruncate$/m);
  const journald = readFileSync(join(prefix, "etc/systemd/journald.conf.d/collab.conf"), "utf8");
  assert.equal(journald, "[Journal]\nSystemMaxUse=300M\nMaxRetentionSec=30day\n");
  run(prefix);
  assert.equal(readFileSync(join(prefix, "etc/logrotate.d/postgresql-common"), "utf8"), rotate);
  assert.equal(readFileSync(join(prefix, "etc/systemd/journald.conf.d/collab.conf"), "utf8"), journald);
});

test("install.sh runs the retention step right after TimescaleDB", () => {
  const ts = install.indexOf('"04-install-timescaledb.sh"');
  const ret = install.indexOf('"04b-log-retention.sh"');
  const redis = install.indexOf('"05-install-redis.sh"');
  assert.ok(ts > 0 && ret > ts && redis > ret);
});
