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
