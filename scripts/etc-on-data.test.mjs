import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = join(root, "scripts/00a-etc-on-data.sh");

function bash(script) {
  return execFileSync("bash", ["-c", script], { encoding: "utf8" });
}

function run(etcDir, dataEtc) {
  const logDir = mkdtempSync(join(tmpdir(), "etc-on-data-log-"));
  return bash(`
    set -euo pipefail
    export LOG_DIR=${JSON.stringify(logDir)}
    export ETC_DIR=${JSON.stringify(etcDir)}
    export DATA_ETC=${JSON.stringify(dataEtc)}
    bash ${JSON.stringify(step)}
  `);
}

function fresh() {
  const base = mkdtempSync(join(tmpdir(), "etc-on-data-"));
  const etc = join(base, "etc-collab");
  const data = join(base, "data-etc");
  return { base, etc, data };
}

test("existing symlink to DATA_ETC is left unchanged", () => {
  const { etc, data } = fresh();
  mkdirSync(data, { mode: 0o755 });
  writeFileSync(join(data, "keep.txt"), "only-on-data\n", { mode: 0o600 });
  symlinkSync(data, etc);
  const before = lstatSync(etc);
  run(etc, data);
  const after = lstatSync(etc);
  assert.equal(readlinkSync(etc), data);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(readFileSync(join(data, "keep.txt"), "utf8"), "only-on-data\n");
});

test("symlink to another target fails and names the target", () => {
  const { base, etc, data } = fresh();
  const other = join(base, "other");
  mkdirSync(other, { mode: 0o755 });
  mkdirSync(data, { mode: 0o755 });
  symlinkSync(other, etc);
  assert.throws(() => run(etc, data), (err) => {
    assert.match(err.stderr, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
  assert.equal(readlinkSync(etc), other);
});

test("real directory is copied, renamed, and replaced by a symlink", () => {
  const { base, etc, data } = fresh();
  mkdirSync(etc, { mode: 0o755 });
  mkdirSync(join(etc, "projects"), { mode: 0o750 });
  writeFileSync(join(etc, "projects", "a.json"), "{\"id\":1}\n", { mode: 0o640 });
  chmodSync(join(etc, "projects", "a.json"), 0o640);
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(data, "appconfig.json"), "{\"secret\":true}\n", { mode: 0o600 });
  const dataMode = lstatSync(data).mode & 0o777;
  const dataUid = lstatSync(data).uid;

  run(etc, data);

  assert.equal(readlinkSync(etc), data);
  assert.equal(readFileSync(join(data, "projects", "a.json"), "utf8"), "{\"id\":1}\n");
  assert.equal(lstatSync(join(data, "projects", "a.json")).mode & 0o777, 0o640);
  assert.equal(lstatSync(join(data, "projects")).mode & 0o777, 0o750);
  assert.equal(lstatSync(data).mode & 0o777, dataMode);
  assert.equal(lstatSync(data).uid, dataUid);
  assert.equal(readFileSync(join(data, "appconfig.json"), "utf8"), "{\"secret\":true}\n");
  assert.equal(lstatSync(join(data, "appconfig.json")).mode & 0o777, 0o600);

  const names = readdirSync(base);
  const pre = names.filter((n) => n.startsWith("etc-collab.pre-data-"));
  assert.equal(pre.length, 1);
  assert.equal(readFileSync(join(base, pre[0], "projects", "a.json"), "utf8"), "{\"id\":1}\n");

  const linkBefore = readlinkSync(etc);
  const backupBefore = pre[0];
  run(etc, data);
  assert.equal(readlinkSync(etc), linkBefore);
  assert.deepEqual(
    readdirSync(base).filter((n) => n.startsWith("etc-collab.pre-data-")),
    [backupBefore],
  );
});

test("different content already in DATA_ETC fails without overwrite", () => {
  const { etc, data } = fresh();
  mkdirSync(etc, { mode: 0o755 });
  writeFileSync(join(etc, "projects.json"), "from-etc\n", { mode: 0o644 });
  mkdirSync(data, { mode: 0o755 });
  writeFileSync(join(data, "projects.json"), "from-data\n", { mode: 0o644 });
  assert.throws(() => run(etc, data), (err) => {
    assert.match(err.stderr, /content conflict:/);
    assert.match(err.stderr, /projects\.json/);
    return true;
  });
  assert.equal(lstatSync(etc).isSymbolicLink(), false);
  assert.equal(readFileSync(join(data, "projects.json"), "utf8"), "from-data\n");
  assert.equal(readFileSync(join(etc, "projects.json"), "utf8"), "from-etc\n");
});

test("missing ETC_DIR becomes a symlink and DATA_ETC is created", () => {
  const { etc, data } = fresh();
  run(etc, data);
  assert.equal(readlinkSync(etc), data);
  assert.equal(lstatSync(data).isDirectory(), true);
  assert.equal(lstatSync(data).mode & 0o777, 0o755);
  run(etc, data);
  assert.equal(readlinkSync(etc), data);
});
