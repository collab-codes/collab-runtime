import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_FILES, compareAgent, expectedInstalled } from "./vm-agent.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO = join(SCRIPTS, "..");

test("expectedInstalled: os 3 arquivos que o instalador reescreve ganham os caminhos da biblioteca; os outros ficam iguais", () => {
  const lib = "/usr/local/lib/collab";
  assert.equal(
    expectedInstalled('import { listPm2 } from "../scripts/pm2-readonly.mjs";\nx\n', "agent/collab-sites-agent.mjs"),
    `import { listPm2 } from "${lib}/pm2-readonly.mjs";\nx\n`,
  );
  const services = expectedInstalled(
    'import a from "./pm2-readonly.mjs";\nimport b from "../scripts/pm2-stop-order.mjs";\nimport c from "../scripts/pm2-lifecycle.mjs";\n',
    "agent/shutdown-services.mjs",
    "/stage",
  );
  assert.equal(services, 'import a from "/stage/usr/local/lib/collab/pm2-readonly.mjs";\nimport b from "/stage/usr/local/lib/collab/pm2-stop-order.mjs";\nimport c from "/stage/usr/local/lib/collab/pm2-lifecycle.mjs";\n');
  assert.equal(expectedInstalled('import x from "../scripts/pm2-readonly.mjs";\n', "agent/shutdown-state.mjs"), 'import x from "../scripts/pm2-readonly.mjs";\n', "shutdown-state não é reescrito");
});

// The rule lives in install-shutdown.sh; this test runs the REAL script and requires that the comparison sees nothing to do:
// if the script changes how it rewrites, the inventory would call the agent out of date forever (found on the 102056, 09/11).
test("depois do install-shutdown.sh real, o agente NÃO aparece como desatualizado (nem pede reinício); mexer num arquivo instalado aparece", () => {
  const prefix = mkdtempSync(join(tmpdir(), "agent-equiv-"));
  try {
    const run = spawnSync("bash", [join(SCRIPTS, "install-shutdown.sh"), "--maintenance-only"], {
      encoding: "utf8",
      env: { ...process.env, COLLAB_SHUTDOWN_PREFIX: prefix, SYSTEMCTL: "true", SYSTEMD_ANALYZE: "true" },
    });
    assert.equal(run.status, 0, run.stderr);
    const input = { runtimeDir: REPO, prefix, exists: existsSync, readText: (p) => readFileSync(p, "utf8") };
    const same = compareAgent(input);
    assert.deepEqual(same.changed, [], "o instalador reescreve imports; a comparação precisa saber disso");
    assert.equal(same.restartNeeded, false);
    assert.equal(same.installedMain, same.checkoutMain);
    // an installed file edited by hand is a difference again
    const installed = join(prefix, AGENT_FILES[0].dest);
    writeFileSync(installed, `${readFileSync(installed, "utf8")}\n// editado\n`);
    const edited = compareAgent(input);
    assert.deepEqual(edited.changed.map((c) => c.file), ["agent/collab-sites-agent.mjs"]);
    assert.equal(edited.restartNeeded, true);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
