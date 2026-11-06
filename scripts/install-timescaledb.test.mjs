import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step04 = readFileSync(join(root, "scripts/04-install-timescaledb.sh"), "utf8");

test("04 enables timescaledb on template1 before createdb", () => {
  const extAt = step04.indexOf(
    "sudo -u postgres psql -d template1 -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'",
  );
  const createdbAt = step04.indexOf('sudo -u postgres createdb "$TEST_DB"');
  assert.ok(extAt > 0 && createdbAt > extAt, "template1 extension is created before createdb");
});

test("04 sets the worker limits once, with the rule written next to them, and restarts at most once", () => {
  assert.match(step04, /ALTER SYSTEM SET max_worker_processes = \$\{TSDB_MAX_WORKER_PROCESSES\}/);
  assert.match(step04, /ALTER SYSTEM SET timescaledb\.max_background_workers = \$\{TSDB_MAX_BACKGROUND_WORKERS\}/);
  assert.match(step04, /ALTER SYSTEM SET timescaledb\.telemetry_level = 'off'/);
  assert.match(step04, /TSDB_MAX_WORKER_PROCESSES:-40/);
  assert.match(step04, /TSDB_MAX_BACKGROUND_WORKERS:-20/);
  assert.match(step04, /pending_restart/);
  assert.equal((step04.match(/systemctl restart postgresql/g) ?? []).length, 1, "a single restart for preload and limits");
  assert.ok(Number(/TSDB_MAX_BACKGROUND_WORKERS:-(\d+)/.exec(step04)[1]) + 3 + 8 <= Number(/TSDB_MAX_WORKER_PROCESSES:-(\d+)/.exec(step04)[1]), "max_worker_processes >= 3 + background workers + parallel workers");
});
