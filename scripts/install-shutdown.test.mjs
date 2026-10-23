import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, "..");
const installer = path.join(here, "install-shutdown.sh");
const bootstrap = path.join(runtime, "install.sh");
const collab = path.join(runtime, "collab");
const shutdownSet = [
  "usr/local/lib/collab-sites-agent/collab-sites-agent.mjs",
  "usr/local/lib/collab-sites-agent/shutdown-state.mjs",
  "usr/local/lib/collab-sites-agent/shutdown-worker.mjs",
  "usr/local/lib/collab-sites-agent/shutdown-services.mjs",
  "usr/local/lib/collab/pm2-lifecycle.mjs",
  "usr/local/lib/collab/pm2-readonly.mjs",
  "usr/local/lib/collab/pm2-stop-order.mjs",
  "etc/systemd/system/collab-shutdown.service",
];
const ID_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ID_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DEADLINE = new Date(NOW + 60 * 60 * 1000).toISOString();

function run(cmd, args, env = {}, cwd = runtime) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd });
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
  const boot = await run("bash", ["-n", bootstrap]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(script.code, 0, script.stderr);
  assert.equal(boot.code, 0, boot.stderr);
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
    const nginx = await readFile(path.join(stage.root, "etc/systemd/system/nginx.service.d/collab-graceful-stop.conf"), "utf8");
    assert.match(nginx, /^ExecStop=$/m);
    assert.match(nginx, /--retry QUIT\/30 /);
    assert.match(nginx, /TimeoutStopSec=35/);
    const timers = (await readdir(path.join(stage.root, "etc/systemd/system"))).filter((name) => name.endsWith(".timer"));
    assert.deepEqual(timers, []);

    const worker = path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-worker.mjs");
    const services = path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-services.mjs");
    const lifecycle = path.join(stage.root, "usr/local/lib/collab/pm2-lifecycle.mjs");
    const readonly = path.join(stage.root, "usr/local/lib/collab/pm2-readonly.mjs");
    const stopOrder = path.join(stage.root, "usr/local/lib/collab/pm2-stop-order.mjs");
    for (const file of [
      worker,
      services,
      lifecycle,
      readonly,
      stopOrder,
      path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-state.mjs"),
      path.join(stage.root, "usr/local/lib/collab-sites-agent/collab-sites-agent.mjs"),
    ]) {
      assert.equal((await stat(file)).mode & 0o777, 0o644);
    }
    const servicesSource = await readFile(services, "utf8");
    assert.match(servicesSource, new RegExp(lifecycle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(servicesSource, new RegExp(readonly.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(servicesSource.includes("../scripts/pm2-lifecycle.mjs"), false);
    assert.equal(servicesSource.includes("../scripts/pm2-readonly.mjs"), false);
    assert.match(servicesSource, new RegExp(stopOrder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(servicesSource.includes("../scripts/pm2-stop-order.mjs"), false);
    const lifecycleSource = await readFile(lifecycle, "utf8");
    assert.match(lifecycleSource, new RegExp(stopOrder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(lifecycleSource.includes("./pm2-stop-order.mjs"), false);
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

async function sha256(file, prefix) {
  let body = await readFile(file);
  if (prefix) body = Buffer.from(body.toString("utf8").split(prefix).join(""));
  return createHash("sha256").update(body).digest("hex");
}

async function bootstrapFunction() {
  const source = await readFile(bootstrap, "utf8");
  const start = source.indexOf("install_ordered_shutdown_set() {");
  const end = source.indexOf("\n# ── Step 8.5:", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("bootstrap and maintenance install the same set and do not fire an old request", async () => {
  const maintained = await stageRoot();
  const booted = await stageRoot();
  try {
    const first = await install(maintained, ["--maintenance-only"]);
    assert.equal(first.code, 0, first.stderr);
    const envBefore = await readFile(booted.envFile, "utf8");
    const modeBefore = (await stat(booted.envFile)).mode & 0o777;
    await mkdir(path.join(booted.root, "var/lib/collab/shutdown"), { recursive: true });
    await writeFile(
      path.join(booted.root, "var/lib/collab/shutdown/current.json"),
      JSON.stringify({ requestId: ID_A, phase: "stopping" }),
    );
    const fn = await bootstrapFunction();
    const ran = await run("bash", ["-c", `${fn}\ninstall_ordered_shutdown_set`], installEnv(booted, { INSTALL_DIR: runtime }));
    assert.equal(ran.code, 0, ran.stderr);
    for (const rel of shutdownSet) {
      assert.equal(
        await sha256(path.join(booted.root, rel), booted.root),
        await sha256(path.join(maintained.root, rel), maintained.root),
        rel,
      );
    }
    const services = await readFile(path.join(booted.root, "usr/local/lib/collab-sites-agent/shutdown-services.mjs"), "utf8");
    assert.match(services, new RegExp(path.join(booted.root, "usr/local/lib/collab/pm2-lifecycle.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(services, new RegExp(path.join(booted.root, "usr/local/lib/collab/pm2-readonly.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(services.includes("../scripts/pm2-readonly.mjs"), false);
    const log = await readFile(booted.log, "utf8");
    assert.match(log, /daemon-reload/);
    assert.doesNotMatch(log, /\b(start|stop|restart|enable)\b/);
    const unit = await readFile(path.join(booted.root, "etc/systemd/system/collab-shutdown.service"), "utf8");
    assert.doesNotMatch(unit, /\[Install\]|WantedBy=/);
    assert.equal(await readFile(booted.envFile, "utf8"), envBefore);
    assert.equal((await stat(booted.envFile)).mode & 0o777, modeBefore);
    assert.equal(
      await readFile(path.join(booted.root, "var/lib/collab/shutdown/current.json"), "utf8"),
      JSON.stringify({ requestId: ID_A, phase: "stopping" }),
    );

    const installSrc = await readFile(bootstrap, "utf8");
    const callAt = installSrc.indexOf("if ! install_ordered_shutdown_set; then");
    const restartAt = installSrc.lastIndexOf("systemctl restart collab-sites-agent");
    assert.ok(callAt > 0 && restartAt > callAt);
    assert.equal(installSrc.includes('cp "$AGENT_SRC" "$AGENT_DEST"'), false);
    assert.equal(installSrc.includes("systemctl start collab-shutdown"), false);
    assert.equal(installSrc.includes("shutdown-worker.mjs run"), false);
  } finally {
    await rm(maintained.root, { recursive: true, force: true });
    await rm(booted.root, { recursive: true, force: true });
  }
});

test("rollback restores the whole set and a partial agent copy does not", async () => {
  const stage = await stageRoot();
  try {
    const installed = await install(stage, ["--maintenance-only"]);
    assert.equal(installed.code, 0, installed.stderr);
    const saved = new Map();
    for (const rel of shutdownSet) saved.set(rel, await readFile(path.join(stage.root, rel)));
    const agentDir = path.join(stage.root, "usr/local/lib/collab-sites-agent");
    await rm(path.join(agentDir, "shutdown-state.mjs"));
    await writeFile(path.join(agentDir, "collab-sites-agent.mjs"), "import './shutdown-state.mjs';\n");
    const broken = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(agentDir, "shutdown-worker.mjs")).href)})`,
    ]);
    assert.notEqual(broken.code, 0);
    for (const [rel, body] of saved) await writeFile(path.join(stage.root, rel), body);
    const restored = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(agentDir, "shutdown-worker.mjs")).href)})`,
    ]);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(await readFile(stage.envFile, "utf8"), "COLLAB_SITES_AGENT_TOKEN=do-not-touch\n");
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

// rt123 s15: both installed consumers of the shared PM2-only order (VM shutdown and ExecStop)
// resolve the staged pm2-stop-order.mjs, without the checkout, and run apps -> msg-worker -> msg.
const STOP_ORDER_REL = "usr/local/lib/collab/pm2-stop-order.mjs";
const CONSUMERS = [
  "usr/local/lib/collab-sites-agent/shutdown-services.mjs",
  "usr/local/lib/collab/pm2-lifecycle.mjs",
];

function importIn(root, rel) {
  return run(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(root, rel)).href)})`],
    {},
    root,
  );
}

test("installed consumers load the staged stop order, and fail without it", async () => {
  const stage = await stageRoot();
  try {
    const installed = await install(stage, ["--maintenance-only"]);
    assert.equal(installed.code, 0, installed.stderr);
    for (const rel of CONSUMERS) {
      const ok = await importIn(stage.root, rel);
      assert.equal(ok.code, 0, `${rel}: ${ok.stderr}`);
    }
    const order = path.join(stage.root, STOP_ORDER_REL);
    const body = await readFile(order);
    await rm(order);
    for (const rel of CONSUMERS) {
      const missing = await importIn(stage.root, rel);
      assert.notEqual(missing.code, 0, rel);
      assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/, rel);
      assert.ok(missing.stderr.includes(order), `${rel} must name the staged path`);
    }
    await writeFile(order, body);
    for (const rel of CONSUMERS) {
      const back = await importIn(stage.root, rel);
      assert.equal(back.code, 0, `${rel}: ${back.stderr}`);
    }
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

function enoent(file) {
  return Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
}

test("installed stopServices runs apps -> msg-worker -> msg before the data services", async () => {
  const stage = await stageRoot();
  try {
    const installed = await install(stage, ["--maintenance-only"]);
    assert.equal(installed.code, 0, installed.stderr);
    const { stopServices } = await import(
      pathToFileURL(path.join(stage.root, "usr/local/lib/collab-sites-agent/shutdown-services.mjs")).href
    );
    const row = (name, pid, extra = {}) => ({ name, pm_id: pid, pid, pm2_env: { status: "online", pm_uptime: pid, ...extra } });
    let processes = [
      row("app-b", 20),
      row("app-a", 21),
      row("msg", 31),
      row("msg-worker", 40),
      row("pm2-logrotate", 50, { pmx_module: true }),
    ];
    const kernel = new Set(processes.map((item) => item.pid));
    const units = { "nginx.service": "up", "redis-server.service": "up", "postgresql.service": "down" };
    const show = (state) => (state === "up"
      ? "MainPID=4242\nTasksCurrent=3\nLoadState=loaded\nActiveState=active\nSubState=running\n"
      : state === "down"
        ? "MainPID=0\nTasksCurrent=0\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n"
        : "MainPID=0\nTasksCurrent=[not set]\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n");
    const order = [];
    let wall = 1_000_000;
    let mono = 0;
    const report = await stopServices({
      requestId: "11111111-1111-4111-8111-111111111111",
      selfDeadlineAt: wall + 90_000,
      now: () => wall,
      mono: () => mono,
      pm2User: "collab",
      pm2Home: "/home/collab/.pm2",
      persist: async () => {},
      control: { inflight: null },
      pollMs: 10,
      sleep: async (ms) => {
        wall += ms;
        mono += ms;
      },
      readProc: (file) => {
        if (file === "/proc/sys/kernel/random/boot_id") return "boot-s15\n";
        const matched = file.match(/^\/proc\/(\d+)\/(stat|status)$/);
        const pid = matched ? Number(matched[1]) : 0;
        if (!kernel.has(pid)) throw enoent(file);
        if (matched[2] === "stat") return `${pid} (node) ${["S", ...Array(18).fill("0"), String(pid * 1000), "0", "0"].join(" ")}\n`;
        return "Name:\tnode\nUid:\t1001\t1001\t1001\t1001\n";
      },
      exec: async (argv) => {
        if (argv[0] === "systemctl" && argv[1] === "show") return { code: 0, stdout: show(units[argv[2]]) };
        if (argv[0] === "systemctl" && argv[1] === "list-units") return { code: 0, stdout: "" };
        if (argv[0] === "systemctl" && argv[1] === "stop") {
          order.push(argv[2]);
          units[argv[2]] = "down";
          return { code: 0, stdout: "" };
        }
        if (argv.includes("which") && argv[argv.length - 1] === "pm2") return { code: 0, stdout: "/usr/bin/pm2\n" };
        if (argv.includes("list") && argv.some((arg) => String(arg).endsWith("/usr/local/lib/collab/pm2-readonly.mjs"))) {
          return { code: 0, stdout: JSON.stringify(processes) };
        }
        if (argv.includes("pm2") && argv.includes("stop")) {
          const name = argv[argv.length - 1];
          order.push(`pm2:${name}`);
          for (const item of processes) if (item.name === name) kernel.delete(item.pid);
          processes = processes.filter((item) => item.name !== name);
          return { code: 0, stdout: "" };
        }
        return { code: 1, stdout: "" };
      },
    });
    assert.deepEqual(order, [
      "nginx.service",
      "pm2:app-a",
      "pm2:app-b",
      "pm2:msg-worker",
      "pm2:msg",
      "redis-server.service",
    ]);
    assert.equal(report.servicesStopped, true, JSON.stringify(report.notStopped));
    assert.equal(report.stopped.includes("pm2-logrotate"), false);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});

test("installed stopPm2 (ExecStop) drains apps -> msg-worker -> msg and kills the daemon last", async () => {
  const stage = await stageRoot();
  try {
    const installed = await install(stage, ["--maintenance-only"]);
    assert.equal(installed.code, 0, installed.stderr);
    const { stopPm2 } = await import(pathToFileURL(path.join(stage.root, "usr/local/lib/collab/pm2-lifecycle.mjs")).href);
    const HOME = "/home/deploy";
    const PM2_HOME = `${HOME}/.pm2`;
    const UNIT = "/sys/fs/cgroup/system.slice/pm2-deploy.service";
    const phased = [
      { name: "shop", pid: 11, start: 2000 },
      { name: "shop", pid: 15, start: 2500 },
      { name: "msg-worker", pid: 12, start: 3000 },
      { name: "msg", pid: 13, start: 4000 },
      { name: "pm2-logrotate", pid: 14, start: 4500, module: true },
    ];
    const environ = `HOME=${HOME}\0PM2_HOME=${PM2_HOME}\0`;
    const procs = new Map();
    const put = (pid, comm, start) => procs.set(pid, {
      stat: `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start}\n`,
      status: "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n",
      environ,
    });
    put(1, "app", 50);
    put(10, "PM2 v5", 1000);
    for (const def of phased) put(def.pid, "node", def.start);
    const cgroup = new Set([1, 10, ...phased.map((def) => def.pid)]);
    const files = new Map([[`${PM2_HOME}/pm2.pid`, "10\n"]]);
    const gone = (pid) => {
      procs.delete(pid);
      cgroup.delete(pid);
    };
    const events = [];
    let now = 0;
    let stopPid = 600;
    let finishKill = null;
    const io = {
      now: () => now,
      async sleep(ms) {
        now += ms;
        finishKill?.(0);
      },
      log() {},
      readFile(file) {
        if (file === "/proc/sys/kernel/random/boot_id") return "boot-s15\n";
        if (files.has(file)) return files.get(file);
        const proc = /^\/proc\/(\d+)\/(stat|status|environ)$/.exec(file);
        const entry = proc ? procs.get(Number(proc[1])) : undefined;
        if (!entry) throw enoent(file);
        return entry[proc[2]];
      },
      exists: (file) => file === `${PM2_HOME}/rpc.sock` || file === UNIT || files.has(file),
      writeAtomic(file, text) {
        files.set(file, text);
      },
      listCgroupPids: (root) => (root === UNIT ? [...cgroup] : [99]),
      jlist: () => [11],
      listProcesses: () => phased.map((def, index) => ({
        pm_id: index,
        name: def.name,
        pid: procs.has(def.pid) ? def.pid : 0,
        pm2_env: { pmx_module: def.module === true },
      })),
      spawnStop(_bin, _home, pmId) {
        events.push(`stop:${phased[pmId].name}`);
        gone(phased[pmId].pid);
        stopPid += 1;
        return { pid: stopPid, finished: Promise.resolve(0) };
      },
      spawnKill() {
        events.push("kill");
        gone(10);
        gone(14);
        files.delete(`${PM2_HOME}/pm2.pid`);
        return { pid: 50, finished: new Promise((resolve) => { finishKill = resolve; }) };
      },
    };
    const code = await stopPm2({
      io,
      pm2Bin: "/usr/bin/pm2",
      pm2Home: PM2_HOME,
      unitCgroup: UNIT,
      uid: 1000,
      home: HOME,
      helperPid: 1,
      deadlineMs: 200,
      pollMs: 10,
    });
    assert.equal(code, 0);
    assert.deepEqual(events, ["stop:shop", "stop:shop", "stop:msg-worker", "stop:msg", "kill"]);
    const receipt = JSON.parse(files.get(`${PM2_HOME}/collab-stop.json`));
    assert.equal(receipt.phase, "stopped");
    assert.equal(receipt.confirmed, true);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
});
