import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// rt184: a new VM is born on the one-tree-per-project layout.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, "scripts", name), "utf8");
const step10 = read("10-mls-runtime.sh");
const step11 = read("11-install-collab-messages.sh");
const step12 = read("12-mls-project.sh");
const update = read("update-collab-runtime.sh");

test("12 defaults to the project tree, clones from the repo when there is no shared checkout, and writes the runtime .env there", () => {
  assert.match(step12, /MLS_PROJECT_TREE="\$\{MLS_PROJECT_TREE:-1\}"/);
  assert.doesNotMatch(step12, /MLS_PROJECT_TREE:-0/);
  assert.match(step12, /\[\[ "\$MLS_PROJECT_TREE" != "1" && ! -d "\$\{MLS_BASE_DIR\}\/\.git" \]\]/, "the shared checkout is required only in the old layout");
  assert.match(step12, /git clone "\$MLS_BASE_REPO" "\$PROJECT_ROOT"/);
  assert.match(step12, /ensure_mls_env "\$PROJECT_ROOT" "\$DEPLOY_USER"/);
  const envAt = step12.indexOf('ensure_mls_env "$PROJECT_ROOT"');
  const initAt = step12.indexOf('projectTreeInit.mjs');
  assert.ok(envAt > 0 && initAt > envAt, "the installer .env is made before projectTreeInit completes the tree");
});

test("12 calls the one projectTreeInit script (rt187) instead of repeating its logic in shell", () => {
  assert.match(step12, /PROJECT_TREE_INIT="\$\{PROJECT_ROOT\}\/scripts\/runtime\/projectTreeInit\.mjs"/);
  assert.match(step12, /--data "\$data_root" --store "\$PNPM_STORE_DIR"/);
  assert.doesNotMatch(step12, /ensureProjectApp/);
  assert.doesNotMatch(step12, /pnpm install/);
  assert.doesNotMatch(step12, /pm2 startOrReload/);
  assert.doesNotMatch(step12, /ensure_env_assignment/);
  assert.doesNotMatch(step12, /projectInit\.mjs" "\$project_id" --root "\$PROJECT_ROOT"/);
});

test("10 does not create the shared /data/mls-base by default, keeps the role/database, and creates /data/logs for the deploy user", () => {
  assert.match(step10, /MLS_PROJECT_TREE="\$\{MLS_PROJECT_TREE:-1\}"/);
  const guard = step10.indexOf('if [[ "$MLS_PROJECT_TREE" == "1" ]]; then');
  const clone = step10.indexOf('git clone "$MLS_BASE_REPO" "$MLS_BASE_DIR"');
  assert.ok(guard > 0 && clone > guard, "the checkout sits in the else branch");
  assert.match(step10, /if \[\[ "\$MLS_PROJECT_TREE" != "1" \]\]; then\n\s+ensure_mls_env "\$MLS_BASE_DIR"/);
  assert.match(step10, /\nensure_app_database\n/);
  assert.match(step10, /DATA_LOGS_DIR="\$\{COLLAB_DATA_ROOT:-\/data\}\/logs"/);
  assert.match(step10, /chown "\$\{DEPLOY_USER\}:" "\$DATA_LOGS_DIR"/);
});

test("11 and update-collab-runtime no longer look for the scripts in /data/mls-base", () => {
  for (const text of [step11, update]) {
    assert.doesNotMatch(text, /\/data\/mls-base\/scripts\/runtime/);
    assert.match(text, /find_runtime_script "\$\{COLLAB_RELEASE_RECORD_SCRIPT:-\}" releaseRecord\.mjs/);
  }
  assert.match(step11, /find_runtime_script "\$\{COLLAB_SHARED_APPS_SCRIPT:-\}" sharedApps\.mjs/);
});

function finderFrom(text) {
  const start = text.indexOf("find_runtime_script() {");
  const end = text.indexOf("\n}\n", start) + 3;
  return text.slice(start, end);
}

function runFinder(text, data, override = "") {
  return execFileSync("bash", ["-c", `${finderFrom(text)}\nfind_runtime_script "$1" releaseRecord.mjs || echo NONE`, "x", override], {
    encoding: "utf8",
    env: { ...process.env, COLLAB_DATA_ROOT: data, COLLAB_ETC_DIR: join(data, "etc") },
  }).trim();
}

function tree(data, id) {
  const dir = join(data, `app${id}`, "mls-base", "scripts", "runtime");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "releaseRecord.mjs"), "// fake\n");
  return join(dir, "releaseRecord.mjs");
}

for (const [name, text] of [["11", step11], ["update-collab-runtime", update]]) {
  test(`${name}: find_runtime_script prefers the override, then the cm main project, then any project tree, never /data/mls-base`, () => {
    const data = mkdtempSync(join(tmpdir(), "rt184-find-"));
    mkdirSync(join(data, "etc"), { recursive: true });
    mkdirSync(join(data, "mls-base", "scripts", "runtime"), { recursive: true });
    writeFileSync(join(data, "mls-base", "scripts", "runtime", "releaseRecord.mjs"), "// old tree\n");
    assert.equal(runFinder(text, data), "NONE", "the old shared tree is not a place to look");
    const first = tree(data, 102047);
    const second = tree(data, 102056);
    assert.equal(runFinder(text, data), first, "no main project: the first tree");
    writeFileSync(join(data, "etc", "shared.json"), '{"cm":{"projetoPrincipal":102056}}\n');
    assert.equal(runFinder(text, data), second, "the cm main project wins");
    const own = join(data, "mine.mjs");
    writeFileSync(own, "// override\n");
    chmodSync(own, 0o644);
    assert.equal(runFinder(text, data, own), own, "an existing override wins");
    assert.equal(runFinder(text, data, join(data, "missing.mjs")), second, "a missing override is ignored");
  });
}
