import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = readFileSync(join(root, "scripts/10-mls-runtime.sh"), "utf8");
const lib = readFileSync(join(root, "scripts/lib/mls-tsrs.sh"), "utf8");
const fn = lib.match(/note_tsrs\(\) \{[\s\S]*?\n\}/);
const project = readFileSync(join(root, "scripts/12-mls-project.sh"), "utf8");

function run(binBody) {
  const dir = mkdtempSync(join(tmpdir(), "rt256-tsrs-"));
  const binDir = join(dir, "node_modules/.bin");
  mkdirSync(binDir, { recursive: true });
  if (binBody !== null) {
    const bin = join(binDir, "tsrs");
    writeFileSync(bin, binBody);
    chmodSync(bin, 0o755);
  }
  const script = `set -euo pipefail
log_info() { printf 'INFO %s\\n' "$*"; }
log_warn() { printf 'WARN %s\\n' "$*"; }
${fn[0]}
note_tsrs ${JSON.stringify(dir)}
`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

test("10 (shared tree) and 12 (tree per project) call note_tsrs after the install", () => {
  assert.ok(fn, "note_tsrs is defined");
  assert.match(lib, /node_modules\/\.bin\/tsrs" -v/);
  assert.match(step, /mls-tsrs\.sh/);
  assert.match(project, /mls-tsrs\.sh/);
  assert.ok(step.indexOf('note_tsrs "$MLS_BASE_DIR"') > step.indexOf('pnpm install"'));
  // 12: after projectTreeInit, which is who runs `pnpm install` in /data/app<id>/mls-base
  assert.ok(project.indexOf('note_tsrs "$PROJECT_ROOT"') > project.indexOf('projectTreeInit: $('));
});

test("tsrs -v is logged and a missing or dead binary warns without failing", () => {
  const ok = run("#!/bin/bash\necho 'tsrs 7.1.0-beta.tsrs3'\n");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /INFO tsrs tsrs 7\.1\.0-beta\.tsrs3/);
  assert.doesNotMatch(ok.stdout, /WARN/);

  const missing = run(null);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /WARN tsrs did not answer -v .* the build will use tsc/);

  const dead = run("#!/bin/bash\nexit 1\n");
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(dead.stdout, /WARN tsrs did not answer -v .* the build will use tsc/);
});
