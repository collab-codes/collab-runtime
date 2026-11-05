import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "release-notices.mjs");
const receiver = join(here, "..", "scripts", "notice-test-receiver.mjs");

test("the cli sends against the test receiver: a 503 keeps the notice, the next round sends it once, a repeat sends nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "notices-cli-"));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const out = join(root, "notices.jsonl");
  const server = spawn(process.execPath, [receiver, "--port", String(port), "--fail-first", "1", "--out", out], { stdio: "ignore" });
  try {
    const dir = join(root, "app102047", "mls-base", "releases", "registro");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "20261105140000.json"), JSON.stringify({ versaoContrato: 2, releaseId: "20261105140000", fila: "app", projetoId: 102047, vmId: "vm-1", resultado: "ok", passos: [{ nome: "install" }] }));
    writeFileSync(join(dir, "20261105140000.aviso-pendente"), JSON.stringify({ codes: ["release.finished"] }));
    for (let i = 0; i < 50; i += 1) {
      const probe = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/api/v1/servers/x/heartbeat",{method:"POST"}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
      if (probe.status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const args = ["--url", `http://127.0.0.1:${port}`, "--server", "srv_t", "--project", "102047", "--token", "tok", "--data-root", root];
    const first = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(first.status, 1, "the 503 is a failed round");
    assert.equal(existsSync(join(dir, "20261105140000.aviso-pendente")), true, "the notice is kept");
    const second = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { sent: 1, failed: 0 });
    assert.equal(existsSync(join(dir, "20261105140000.aviso-pendente")), false);
    const third = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(third.stdout), { sent: 0, failed: 0 });
    const lines = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].key, "vm-1|102047|20261105140000|release.finished");
    assert.equal(lines[0].vezes, 1);
    assert.equal(lines[0].temToken, true);
  } finally {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
