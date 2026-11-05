import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "update-collab-runtime.sh");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "upd-rt-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "a.txt"), "1\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "one");
  const checkout = join(root, "collab-runtime");
  execFileSync("git", ["clone", "-q", origin, checkout]);
  const log = join(root, "record.log");
  const stub = join(root, "releaseRecord.mjs");
  writeFileSync(stub, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\n`);
  return { root, origin, checkout, log, stub };
}

function run(ctx) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, COLLAB_RUNTIME_DIR: ctx.checkout, COLLAB_ETC_DIR: join(ctx.root, "etc"), COLLAB_RELEASE_RECORD_SCRIPT: ctx.stub },
  });
}

test("the management update records before/after commits in the vm queue", () => {
  const ctx = setup();
  try {
    const before = git(ctx.checkout, "rev-parse", "HEAD");
    writeFileSync(join(ctx.origin, "a.txt"), "2\n");
    git(ctx.origin, "commit", "-q", "-am", "two");
    const after = git(ctx.origin, "rev-parse", "HEAD");
    const result = run(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(ctx.checkout, "rev-parse", "HEAD"), after);
    const line = readFileSync(ctx.log, "utf8").trim();
    assert.match(line, new RegExp(`^vm --antes ${before} --depois ${after} --repo-dir ${ctx.checkout.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} --etc ${join(ctx.root, "etc")} --passos pull --inicio \\S+ --resultado ok`));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a failed update records falhou at the pull step and still exits non-zero", () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.checkout, "a.txt"), "local edit\n");
    git(ctx.checkout, "commit", "-q", "-am", "diverged");
    writeFileSync(join(ctx.origin, "a.txt"), "other\n");
    git(ctx.origin, "commit", "-q", "-am", "remote");
    const result = run(ctx);
    assert.notEqual(result.status, 0);
    const line = readFileSync(ctx.log, "utf8").trim();
    assert.match(line, /--resultado falhou --falha pull --mensagem update exited with status \d+/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
