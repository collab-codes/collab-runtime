import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const installerPath = join(here, "11-install-collab-messages.sh");
const installer = readFileSync(installerPath, "utf8");

test("the installer downloads pnpm-lock.yaml with the other release files", () => {
  assert.match(installer, /curl -fsS[^\n]*\$\{VERSION\}\/pnpm-lock\.yaml/);
});

test("a release without pnpm-lock.yaml (404) does not abort the install", () => {
  // set -euo pipefail is on: the download must sit inside an `if !`, never bare.
  assert.match(
    installer,
    /if ! curl -fsS[^\n]*-o "\$INSTALL_DIR_MSG\/pnpm-lock\.yaml\.download"[^\n]*pnpm-lock\.yaml"; then/,
  );
  assert.match(installer, /log_warn "release \$\{VERSION\} has no pnpm-lock\.yaml/);
  assert.doesNotMatch(installer, /^curl[^\n]*pnpm-lock\.yaml"?$/m);
});

test("a release without the lock drops the lock left by a previous release", () => {
  // curl -f leaves an existing output file untouched on 404, so a stale lock
  // would otherwise be handed to addNewVersion as if it were this release's.
  assert.match(
    installer,
    /rm -f "\$INSTALL_DIR_MSG\/pnpm-lock\.yaml\.download" "\$INSTALL_DIR_MSG\/pnpm-lock\.yaml"/,
  );
});

test("a successful download lands as install/pnpm-lock.yaml", () => {
  assert.match(
    installer,
    /mv -f "\$INSTALL_DIR_MSG\/pnpm-lock\.yaml\.download" "\$INSTALL_DIR_MSG\/pnpm-lock\.yaml"/,
  );
});

test("the installer is valid bash", () => {
  execFileSync("bash", ["-n", installerPath], { stdio: "pipe" });
});
