import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, "..");
const installer = path.join(here, "install-shutdown.sh");
const collab = path.join(runtime, "collab");
const ID_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ID_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DEADLINE = new Date(NOW + 60 * 60 * 1000).toISOString();

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: runtime });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function stageRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "rt116-s5-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "systemctl.log");
  await mkdir(bin);
  await writeFile(log, "");
  const systemctl = path.join(bin, "systemctl");
  await writeFile(systemctl, `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  daemon-reload) exit 0 ;;
  restart)
    if [[ "\${ALLOW_AGENT_RESTART:-}" == "1" && "$2" == "collab-sites-agent" ]]; then
      exit 0
    fi
    exit 99 ;;
  *) exit 99 ;;
esac
`);
  const analyze = path.join(bin, "systemd-analyze");
  await writeFile(analyze, `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
[[ "$1" == "verify" && -n "$2" ]] || exit 1
unit="$2"
grep -q '^RuntimeMaxSec=54min$' "$unit" || exit 1
grep -q 'shutdown-worker.mjs run$' "$unit" || exit 1
grep -q '^Restart=on-failure$' "$unit" || exit 1
grep -q '^Type=simple$' "$unit" || exit 1
if grep -q '^\\[Install\\]' "$unit" || grep -q 'WantedBy=' "$unit"; then
  exit 1
fi
exit 0
`);
  await chmod(systemctl, 0o755);
  await chmod(analyze, 0o755);
  const envFile = path.join(root, "etc/collab-sites-agent.env");
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, "COLLAB_SITES_AGENT_TOKEN=do-not-touch\n", { mode: 0o600 });
  return { root, log, envFile, systemctl, analyze };
}

function installEnv(stage, extra = {}) {
  return {
    COLLAB_SHUTDOWN_PREFIX: stage.root,
    SYSTEMCTL: stage.systemctl,
    SYSTEMD_ANALYZE: stage.analyze,
    ...extra,
  };
}

async function install(stage, args, extra) {
  return run("bash", [installer, ...args], installEnv(stage, extra));
}

test("bash -n accepts the cli and the installer", async () => {
  const cli = await run("bash", ["-n", collab]);
  const script = await run("bash", ["-n", installer]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(script.code, 0, script.stderr);
});

test("help names vm shutdown and the command stays root-only", async () => {
  const help = await run("bash", [collab, "help"]);
  const bare = await run("bash", [collab, "vm"]);
  const denied = await run("bash", [collab, "vm", "shutdown", "--script", "/tmp/evil.sh"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /vm shutdown/);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /\/usr\/local\/lib\/collab-sites-agent\/shutdown-worker\.mjs/);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /must be run as root/);
  const source = await readFile(collab, "utf8");
  const body = source.slice(source.indexOf("cmd_vm()"), source.indexOf("cmd_help()"));
  assert.equal(body.includes("/data/collab-runtime"), false);
  assert.equal(body.includes("--script"), false);
});

test("vm shutdown accepts only request id and deadline", async () => {
  const source = await readFile(collab, "utf8");
  const fn = source.slice(source.indexOf("vm_shutdown_args_ok()"), source.indexOf("cmd_vm()"));
  const check = async (args) => run("bash", ["-c", `${fn}\nvm_shutdown_args_ok "$@"`, "bash", ...args]);
  assert.equal((await check(["--request-id", ID_A, "--deadline", DEADLINE])).code, 0);
  assert.equal((await check(["--deadline", DEADLINE, "--request-id", ID_A])).code, 0);
  assert.notEqual((await check(["--request-id", ID_A])).code, 0);
  assert.notEqual((await check(["--request-id", ID_A, "--deadline", DEADLINE, "--script", "/tmp/x"])).code, 0);
  assert.notEqual((await check(["--request-id", ID_A, "--request-id", ID_B, "--deadline", DEADLINE])).code, 0);
  assert.notEqual((await check(["--dest", "/tmp", "--request-id", ID_A, "--deadline", DEADLINE])).code, 0);
});

test("maintenance install is idempotent and does not start a worker or touch env", async () => {
  const stage = await stageRoot();
  try {
    const first = await install(stage, ["--maintenance-only"]);
    assert.equal(first.code, 0, first.stderr);
    const envBefore = await readFile(stage.envFile, "utf8");
    const modeBefore = (await stat(stage.envFile)).mode & 0o777;
    const second = await install(stage, ["--maintenance-only"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await readFile(stage.envFile, "utf8"), envBefore);
    assert.equal((await stat(stage.envFile)).mode & 0o777, modeBefore);

    const log = await readFile(stage.log, "utf8");
    assert.match(log, /daemon-reload/);
    assert.match(log, /verify /);
    assert.doesNotMatch(log, /\b(start|stop|restart|enable)\b/);

    const unit = await readFile(path.join(stage.root, "etc/systemd/system/collab-shutdown.service"), "utf8");
    assert.match(unit, /RuntimeMaxSec=54min/);
    assert.doesNotMatch(unit, /\[Install\]|WantedBy=/);
    const timers = (await readdir(path.join(stage.root, "etc/systemd/system"))).filter((name) => name.endsWith(".timer"));
    assert.deepEqual(timers, []);

    const worker = path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-worker.mjs");
    const services = path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-services.mjs");
    const lifecycle = path.join(stage.root, "usr/local/lib/collab/pm2-lifecycle.mjs");
    for (const file of [
      worker,
      services,
      lifecycle,
      path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-state.mjs"),
      path.join(stage.root, "usr/local/lib/collab-sites-agent/collab-sites-agent.mjs"),
    ]) {
      assert.equal((await stat(file)).mode & 0o777, 0o644);
    }
    const servicesSource = await readFile(services, "utf8");
    assert.match(servicesSource, new RegExp(lifecycle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(servicesSource.includes("../scripts/pm2-lifecycle.mjs"), false);
    await import(pathToFileURL(services).href);
    await import(pathToFileURL(worker).href);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("restart-agent restarts only the sites agent", async () => {
  const stage = await stageRoot();
  try {
    const result = await install(stage, ["--maintenance-only", "--restart-agent"], { ALLOW_AGENT_RESTART: "1" });
    assert.equal(result.code, 0, result.stderr);
    const log = await readFile(stage.log, "utf8");
    assert.match(log, /restart collab-sites-agent/);
    assert.doesNotMatch(log, /\bstart\b/);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("installed prepare covers root, duplicate, crash, busy and rejection", async () => {
  const stage = await stageRoot();
  try {
    const installed = await install(stage, ["--maintenance-only"]);
    assert.equal(installed.code, 0, installed.stderr);
    const agentDir = path.join(stage.root, "usr/local/lib/collab-sites-agent");
    const { prepare } = await import(pathToFileURL(path.join(agentDir, "shutdown-worker.mjs")).href);
    const state = await import(pathToFileURL(path.join(agentDir, "shutdown-state.mjs")).href);
    const stateDir = path.join(stage.root, "var/lib/collab/shutdown");
    let starts = 0;
    const deps = {
      getuid: () => 0,
      bootId: "boot-s5",
      stateDir,
      now: () => NOW,
      mono: () => 1_000,
      startUnit: async () => {
        starts += 1;
        return { ok: true };
      },
    };
    const argv = ["--request-id", ID_A, "--deadline", DEADLINE];
    const accepted = await prepare(argv, deps);
    assert.equal(accepted.result, "accepted");
    assert.equal(accepted.requestId, ID_A);
    const again = await prepare(argv, deps);
    assert.equal(again.result, "existing");
    assert.equal(again.requestId, ID_A);
    assert.equal(starts, 2);

    const unprivileged = await prepare(argv, { ...deps, getuid: () => 50, stateDir: path.join(stage.root, "var/other") });
    assert.equal(unprivileged.result, "rejected");
    assert.equal(unprivileged.reason, "not_root");

    const crashDir = path.join(stage.root, "var/crash");
    let crashed = 0;
    const crashDeps = {
      ...deps,
      stateDir: crashDir,
      startUnit: async () => {
        crashed += 1;
        if (crashed === 1) throw new Error("job refused");
        return { ok: true };
      },
    };
    const crashedResult = await prepare(argv, crashDeps);
    assert.equal(crashedResult.result, "start_unconfirmed");
    const resumed = await prepare(argv, crashDeps);
    assert.equal(resumed.result, "existing");
    assert.equal(resumed.requestId, ID_A);
    assert.equal(crashed, 2);

    const moved = await state.transitionShutdown({
      phase: "services_stopped",
      report: {
        stopped: ["nginx"],
        notStopped: [],
        startedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW + 1000).toISOString(),
      },
    }, crashDeps);
    assert.equal(moved.result, "durable");
    const startsBeforeBusy = crashed;
    const busy = await prepare(["--request-id", ID_B, "--deadline", DEADLINE], crashDeps);
    assert.equal(busy.result, "busy");
    assert.equal(crashed, startsBeforeBusy);

    const rejected = await prepare(["--request-id", "not-a-uuid", "--deadline", DEADLINE], {
      ...deps,
      stateDir: path.join(stage.root, "var/rejected"),
      startUnit: async () => {
        throw new Error("must not start");
      },
    });
    assert.equal(rejected.result, "rejected");
    await assert.rejects(stat(path.join(stage.root, "var/rejected/current.json")));
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});
