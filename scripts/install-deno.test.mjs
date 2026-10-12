import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = join(root, "scripts/06b-install-deno.sh");

function bash(script) {
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
}

// uname -m is mocked. logger.sh appends under LOG_DIR, which must exist.
function run(machine, preamble, body) {
  const logDir = mkdtempSync(join(tmpdir(), "deno-log-"));
  return bash(`
    {
      set -euo pipefail
      uname() {
        if [[ "\${1:-}" == "-m" ]]; then
          printf '%s\\n' ${JSON.stringify(machine)}
        else
          command uname "\$@"
        fi
      }
      export LOG_DIR=${JSON.stringify(logDir)}
      ${preamble}
      source ${JSON.stringify(step)}
      ${body}
    } 2>&1
  `);
}

function fakeDeno(versionLine) {
  const bin = mkdtempSync(join(tmpdir(), "deno-bin-"));
  const path = join(bin, "deno");
  writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(versionLine)} 'v8 1'\n`);
  chmodSync(path, 0o755);
  return bin;
}

test("asset target follows uname -m", () => {
  assert.equal(
    run("x86_64", "", "deno_asset_target"),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    run("aarch64", "", "deno_asset_target"),
    "aarch64-unknown-linux-gnu",
  );
});

test("unknown architecture is refused", () => {
  const out = run(
    "ppc64le",
    "",
    `if deno_asset_target; then printf '%s\\n' unexpected; else printf '%s\\n' refused; fi`,
  );
  assert.match(out, /unsupported architecture for Deno: ppc64le/);
  assert.match(out, /refused/);
});

test("major-only DENO_VERSION uses latest; minor/patch pins the tag", () => {
  assert.equal(
    run("x86_64", "DENO_VERSION=2", 'deno_release_url "$(deno_asset_target)"'),
    "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip",
  );
  assert.equal(
    run("aarch64", "DENO_VERSION=2.1.4", 'deno_release_url "$(deno_asset_target)"'),
    "https://github.com/denoland/deno/releases/download/v2.1.4/deno-aarch64-unknown-linux-gnu.zip",
  );
});

test("skips when the installed major already matches", () => {
  const bin = fakeDeno("deno 2.4.1 (release, aarch64-unknown-linux-gnu)");
  const out = run(
    "aarch64",
    `export PATH=${JSON.stringify(bin)}:$PATH\nDENO_VERSION=2`,
    "install_deno\nprintf '%s\\n' SHOULD_NOT_RUN",
  );
  assert.match(out, /already installed \(major 2\)/);
  assert.doesNotMatch(out, /SHOULD_NOT_RUN/);
  assert.doesNotMatch(out, /Installing prerequisite/);
});

test("install.sh exports DENO_VERSION before run_step 06b", () => {
  const install = readFileSync(join(root, "install.sh"), "utf8");
  const exportAt = install.indexOf("export DENO_VERSION=");
  const stepAt = install.indexOf("run_step 06b");
  assert.ok(exportAt >= 0);
  assert.ok(stepAt > exportAt);
});

test("does not skip when deno is missing or the major differs", () => {
  assert.equal(
    run(
      "x86_64",
      "DENO_VERSION=2\nexport PATH=/usr/bin:/bin",
      "if deno_major_matches; then printf '%s\\n' skip; else printf '%s\\n' install; fi",
    ),
    "install",
  );
  const bin = fakeDeno("deno 1.46.3 (release, x86_64-unknown-linux-gnu)");
  assert.equal(
    run(
      "x86_64",
      `export PATH=${JSON.stringify(bin)}:$PATH\nDENO_VERSION=2`,
      "if deno_major_matches; then printf '%s\\n' skip; else printf '%s\\n' install; fi",
    ),
    "install",
  );
});
