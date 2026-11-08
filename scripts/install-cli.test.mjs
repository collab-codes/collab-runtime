import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const INSTALL_CLI = join(SCRIPTS, "install-cli.sh");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const FILES = ["11-install-collab-messages.sh", "msg-configure.mjs", "msg-vapid.mjs", "vm-inventory.mjs", "vm-update.mjs"];

/** A fake checkout with the CLI and the scripts it installs (contents are markers, not the real files). */
function checkout(root, tag) {
  const dir = join(root, "src");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "collab"), `#!/bin/bash\n# collab ${tag}\n`);
  for (const name of FILES) writeFileSync(join(dir, "scripts", name), `// ${name} ${tag}\n`);
  return dir;
}

function install(src, prefix) {
  return spawnSync("bash", [INSTALL_CLI], { encoding: "utf8", env: { ...process.env, COLLAB_CLI_SRC: src, COLLAB_CLI_PREFIX: prefix } });
}

const dest = (prefix, name) => join(prefix, "usr/local/lib/collab", name);

test("copia a CLI e os scripts que ela chama, executáveis", () => {
  const root = mkdtempSync(join(tmpdir(), "inst-cli-"));
  try {
    const src = checkout(root, "v1");
    const prefix = join(root, "vm");
    const result = install(src, prefix);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(prefix, "usr/local/bin/collab"), "utf8"), "#!/bin/bash\n# collab v1\n");
    assert.equal(readFileSync(dest(prefix, "install-collab-messages.sh"), "utf8"), "// 11-install-collab-messages.sh v1\n");
    for (const name of ["msg-configure.mjs", "msg-vapid.mjs", "vm-inventory.mjs", "vm-update.mjs"]) {
      assert.equal(readFileSync(dest(prefix, name), "utf8"), `// ${name} v1\n`);
      assert.ok((statSync(dest(prefix, name)).mode & 0o111) !== 0, `${name} executável`);
    }
    assert.ok((statSync(join(prefix, "usr/local/bin/collab")).mode & 0o111) !== 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rodar de novo não muda nada; mudar um arquivo copia só esse", () => {
  const root = mkdtempSync(join(tmpdir(), "inst-cli-"));
  try {
    const src = checkout(root, "v1");
    const prefix = join(root, "vm");
    install(src, prefix);
    const again = install(src, prefix);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /collab CLI: unchanged/u);
    assert.doesNotMatch(again.stdout, /updated/u);
    writeFileSync(join(src, "scripts", "vm-update.mjs"), "// vm-update.mjs v2\n");
    const third = install(src, prefix);
    assert.equal((third.stdout.match(/updated/gu) ?? []).length, 1);
    assert.match(third.stdout, /updated .*vm-update\.mjs/u);
    assert.equal(readFileSync(dest(prefix, "vm-update.mjs"), "utf8"), "// vm-update.mjs v2\n");
    assert.equal(readFileSync(dest(prefix, "vm-inventory.mjs"), "utf8"), "// vm-inventory.mjs v1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cópia instalada que perdeu o bit de execução volta a ser executável", () => {
  const root = mkdtempSync(join(tmpdir(), "inst-cli-"));
  try {
    const src = checkout(root, "v1");
    const prefix = join(root, "vm");
    install(src, prefix);
    chmodSync(dest(prefix, "vm-inventory.mjs"), 0o644);
    assert.match(install(src, prefix).stdout, /updated .*vm-inventory\.mjs/u);
    assert.ok((statSync(dest(prefix, "vm-inventory.mjs")).mode & 0o111) !== 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sem a CLI na origem, ou sem um dos scripts, falha com mensagem e exit != 0", () => {
  const root = mkdtempSync(join(tmpdir(), "inst-cli-"));
  try {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const noCli = install(empty, join(root, "vm"));
    assert.notEqual(noCli.status, 0);
    assert.match(noCli.stderr, /collab CLI source not found/u);
    const src = checkout(root, "v1");
    rmSync(join(src, "scripts", "vm-update.mjs"));
    const missing = install(src, join(root, "vm2"));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing source file: .*vm-update\.mjs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("o install.sh usa este mesmo passo e não tem mais a cópia própria", () => {
  const text = readFileSync(join(SCRIPTS, "..", "install.sh"), "utf8");
  assert.match(text, /scripts\/install-cli\.sh/u);
  assert.doesNotMatch(text, /cp "\$\{INSTALL_DIR\}\/scripts\/vm-inventory\.mjs"/u);
  assert.doesNotMatch(text, /cp "\$CLI_SRC" "\$CLI_DEST"/u);
});

test("update-collab-runtime.sh: depois do pull reinstala a CLI do checkout novo, sem reiniciar serviço, e registra o passo cli", () => {
  const root = mkdtempSync(join(tmpdir(), "upd-cli-"));
  try {
    const origin = join(root, "origin");
    mkdirSync(origin);
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    const gitIn = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
    const seed = checkout(root, "v1");
    cpSync(seed, origin, { recursive: true });
    cpSync(INSTALL_CLI, join(origin, "scripts", "install-cli.sh"));
    gitIn(origin, "add", "-A");
    gitIn(origin, "commit", "-q", "-m", "one");
    const runtime = join(root, "collab-runtime");
    execFileSync("git", ["clone", "-q", origin, runtime]);
    const prefix = join(root, "vm");
    const log = join(root, "record.log");
    const stub = join(root, "releaseRecord.mjs");
    writeFileSync(stub, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\n`);
    const env = { ...process.env, ...GIT_ENV, COLLAB_RUNTIME_DIR: runtime, COLLAB_ETC_DIR: join(root, "etc"), COLLAB_RELEASE_RECORD_SCRIPT: stub, COLLAB_CLI_PREFIX: prefix };
    const update = () => spawnSync("bash", [join(SCRIPTS, "update-collab-runtime.sh")], { encoding: "utf8", env });

    // the origin moves: a new CLI and a new vm-update.mjs
    writeFileSync(join(origin, "collab"), "#!/bin/bash\n# collab v2\n");
    writeFileSync(join(origin, "scripts", "vm-update.mjs"), "// vm-update.mjs v2\n");
    gitIn(origin, "commit", "-q", "-am", "two");
    const first = update();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(prefix, "usr/local/bin/collab"), "utf8"), "#!/bin/bash\n# collab v2\n");
    assert.equal(readFileSync(dest(prefix, "vm-update.mjs"), "utf8"), "// vm-update.mjs v2\n");
    assert.match(readFileSync(log, "utf8"), /--passos pull,cli /u);

    // nothing new: the same files, nothing copied
    writeFileSync(log, "");
    const second = update();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /collab CLI: unchanged/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update-collab-runtime.sh: falha da instalação da CLI registra falhou no passo cli", () => {
  const root = mkdtempSync(join(tmpdir(), "upd-cli-"));
  try {
    const origin = join(root, "origin");
    mkdirSync(join(origin, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    const gitIn = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
    // a checkout whose install-cli.sh finds no `collab` to install
    cpSync(INSTALL_CLI, join(origin, "scripts", "install-cli.sh"));
    gitIn(origin, "add", "-A");
    gitIn(origin, "commit", "-q", "-m", "one");
    const runtime = join(root, "collab-runtime");
    execFileSync("git", ["clone", "-q", origin, runtime]);
    const log = join(root, "record.log");
    const stub = join(root, "releaseRecord.mjs");
    writeFileSync(stub, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\n`);
    const result = spawnSync("bash", [join(SCRIPTS, "update-collab-runtime.sh")], {
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV, COLLAB_RUNTIME_DIR: runtime, COLLAB_ETC_DIR: join(root, "etc"), COLLAB_RELEASE_RECORD_SCRIPT: stub, COLLAB_CLI_PREFIX: join(root, "vm") },
    });
    assert.notEqual(result.status, 0);
    assert.match(readFileSync(log, "utf8"), /--resultado falhou --falha cli /u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
