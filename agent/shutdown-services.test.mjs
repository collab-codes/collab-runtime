import assert from "node:assert/strict";
import test from "node:test";
import { stopServices } from "./shutdown-services.mjs";

const REQUEST = "11111111-1111-4111-8111-111111111111";

function show(state) {
  if (state === "missing") return "MainPID=0\nTasksCurrent=[not set]\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n";
  if (state === "down") return "MainPID=0\nTasksCurrent=0\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n";
  if (state === "exited") return "MainPID=0\nTasksCurrent=0\nLoadState=loaded\nActiveState=active\nSubState=exited\n";
  if (state === "up") return "MainPID=4242\nTasksCurrent=3\nLoadState=loaded\nActiveState=active\nSubState=running\n";
  return state;
}

function proc(name, pid, status = "online", startTime = pid) {
  return { name, pm_id: pid, pid, pm2_env: { status, pm_uptime: startTime } };
}

// Kernel start time deliberately differs from pm_uptime: identities must come from /proc.
function kernelStart(pid) {
  return pid * 1000 + 7;
}

function statText(pid, startTime) {
  const fields = ["S", ...Array(18).fill("0"), String(startTime), "0", "0"];
  return `${pid} (node a) b) ${fields.join(" ")}\n`;
}

function enoent(path) {
  return Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
}

function kernelFrom(rows) {
  const kernel = new Map();
  for (const row of rows) {
    if (row.pid > 0) kernel.set(row.pid, { startTime: kernelStart(row.pid), uid: 1001 });
  }
  return kernel;
}

function harness(overrides = {}) {
  const calls = [];
  const intents = [];
  const logs = [];
  let wall = 1_000_000;
  let mono = 0;
  const units = {
    "nginx.service": "up",
    "redis-server.service": "up",
    "postgresql.service": "exited",
    "postgresql@17-main.service": "up",
  };
  let processes = [
    proc("app-b", 20),
    proc("msg", 31),
    proc("msg", 32),
    proc("msg-worker", 40),
  ];
  let kernel = kernelFrom(processes);
  let bootId = "boot-1";
  const readProc = (path) => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
    const matched = path.match(/^\/proc\/(\d+)\/(stat|status)$/);
    const entry = matched ? kernel.get(Number(matched[1])) : undefined;
    if (!entry) throw enoent(path);
    if (entry.error) throw Object.assign(new Error(entry.error), { code: entry.error });
    if (matched[2] === "stat") return statText(Number(matched[1]), entry.startTime);
    return `Name:\tnode\nUid:\t${entry.uid}\t${entry.uid}\t${entry.uid}\t${entry.uid}\n`;
  };
  const control = { inflight: null };
  const exec = (argv) => {
    calls.push(argv.slice());
    if (argv[0] === "systemctl" && argv[1] === "show") {
      const unit = argv[2];
      return Promise.resolve({ code: 0, stdout: show(units[unit] ?? "missing") });
    }
    if (argv[0] === "systemctl" && argv[1] === "list-units") {
      const line = units["postgresql@17-main.service"]
        ? "postgresql@17-main.service loaded active running\n"
        : "";
      return Promise.resolve({ code: 0, stdout: line });
    }
    if (argv[0] === "systemctl" && argv[1] === "stop") {
      units[argv[2]] = "down";
      return Promise.resolve({ code: 0, stdout: "" });
    }
    if (argv.includes("which") && argv[argv.length - 1] === "pm2") {
      return Promise.resolve({ code: 0, stdout: "/usr/bin/pm2\n" });
    }
    if (argv.includes("list") && argv.some((arg) => String(arg).includes("pm2-readonly.mjs"))) {
      return Promise.resolve({ code: 0, stdout: JSON.stringify(processes) });
    }
    if (argv.includes("stop") && argv.includes("pm2")) {
      const name = argv[argv.length - 1];
      for (const row of processes) if (row.name === name) kernel.delete(row.pid);
      processes = processes.filter((row) => row.name !== name);
      return Promise.resolve({ code: 0, stdout: "TOKEN=secret\n" });
    }
    return Promise.resolve({ code: 1, stdout: "TOKEN=secret\n" });
  };
  const deps = {
    requestId: REQUEST,
    selfDeadlineAt: wall + 60_000 + 30_000,
    now: () => wall,
    mono: () => mono,
    pm2User: "collab",
    pm2Home: "/home/collab/.pm2",
    bootId: "boot-1",
    log: (line) => logs.push(line),
    persist: async (intent) => {
      intents.push(intent);
    },
    exec,
    readProc,
    control,
    pollMs: 10,
    sleep: async (ms) => {
      mono += ms;
      wall += ms;
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    intents,
    logs,
    units,
    control,
    kernel: () => kernel,
    setBootId: (next) => {
      bootId = next;
    },
    setProcesses: (next) => {
      processes = next;
      kernel = kernelFrom(next);
    },
    getProcesses: () => processes,
    advance: (ms) => {
      mono += ms;
      wall += ms;
    },
  };
}

function stopArgv(calls) {
  return calls.filter((argv) => argv[1] === "stop" || (argv.includes("pm2") && argv.includes("stop")));
}

test("stops nginx, unknown apps, worker, msg, then redis and the pg cluster", async () => {
  const h = harness();
  const report = await stopServices(h.deps);
  const stops = stopArgv(h.calls).map((argv) => argv[argv.length - 1]);
  assert.deepEqual(stops, [
    "nginx.service",
    "app-b",
    "msg-worker",
    "msg",
    "redis-server.service",
    "postgresql@17-main.service",
  ]);
  assert.equal(report.servicesStopped, true);
  assert.deepEqual(report.notStopped, []);
  assert.ok(report.stopped.includes("nginx"));
  assert.ok(report.stopped.includes("msg"));
  assert.equal(h.calls.some((argv) => argv.includes("kill") || argv.includes("save") || argv.includes("resurrect") || argv.includes("delete")), false);
  assert.equal(h.logs.some((line) => line.includes("secret")), false);
  assert.equal(h.intents[0].name, "nginx");
  assert.ok(h.intents.every((intent) => intent.requestId === REQUEST));
});

test("a process that is still alive blocks redis and postgresql", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      h.calls.push(argv.slice());
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.equal(report.servicesStopped, false);
  assert.ok(report.notStopped.includes("app-b"));
  assert.equal(h.calls.some((argv) => argv[argv.length - 1] === "redis-server.service" && argv[1] === "stop"), false);
  assert.equal(h.calls.some((argv) => String(argv[2] || "").startsWith("postgresql@") && argv[1] === "stop"), false);
});

test("lost rpc and a missing daemon are not an empty stop", async () => {
  for (const code of [1, 1]) {
    const h = harness();
    h.deps.exec = (argv) => {
      h.calls.push(argv.slice());
      if (argv.includes("which") && argv[argv.length - 1] === "pm2") {
        return Promise.resolve({ code: 0, stdout: "/usr/bin/pm2\n" });
      }
      if (argv.includes("list") && argv.some((arg) => String(arg).includes("pm2-readonly.mjs"))) {
        return Promise.resolve({ code, stdout: "" });
      }
      if (argv[0] === "systemctl" && argv[1] === "show") {
        return Promise.resolve({ code: 0, stdout: show(h.units[argv[2]] ?? "missing") });
      }
      if (argv[0] === "systemctl" && argv[1] === "list-units") {
        return Promise.resolve({ code: 0, stdout: "postgresql@17-main.service loaded active running\n" });
      }
      if (argv[1] === "stop") return Promise.resolve({ code: 0, stdout: "" });
      return Promise.resolve({ code: 1, stdout: "" });
    };
    const report = await stopServices(h.deps);
    assert.equal(report.servicesStopped, false);
    assert.ok(report.notStopped.includes("pm2"));
    assert.equal(h.calls.filter((argv) => argv.includes("list") && argv.some((arg) => String(arg).includes("pm2-readonly.mjs"))).length >= 1, true);
    assert.equal(h.calls.some((argv) => argv.includes("jlist") || argv.includes("start")), false);
    assert.equal(h.calls.some((argv) => argv.includes("pm2") && argv.includes("stop")), false);
    assert.equal(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "redis-server.service"), false);
  }
});

test("pm2 status stopped with a live pid is not stopped", async () => {
  const h = harness();
  h.setProcesses([proc("app-b", 20, "stopped", 20), proc("msg", 31, "stopping", 31)]);
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop")) {
      h.calls.push(argv.slice());
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.equal(report.servicesStopped, false);
  assert.ok(report.notStopped.includes("app-b"));
  assert.equal(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "redis-server.service"), false);
});

test("postgresql umbrella exited still stops the live cluster", async () => {
  const h = harness();
  h.setProcesses([]);
  h.units["nginx.service"] = "down";
  h.units["redis-server.service"] = "down";
  const report = await stopServices(h.deps);
  assert.ok(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "postgresql@17-main.service"));
  assert.equal(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "postgresql.service"), false);
  assert.equal(report.servicesStopped, true);
});

test("a cluster that stays up is not services_stopped", async () => {
  const h = harness();
  h.setProcesses([]);
  h.units["nginx.service"] = "down";
  h.units["redis-server.service"] = "down";
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv[1] === "stop" && argv[2] === "postgresql@17-main.service") {
      h.calls.push(argv.slice());
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.equal(report.servicesStopped, false);
  assert.ok(report.notStopped.includes("postgresql@17-main.service"));
});

test("a stuck control command is not run twice and abort returns facts", async () => {
  const h = harness();
  const control = h.control;
  let stops = 0;
  let release;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  h.deps.exec = (argv) => {
    h.calls.push(argv.slice());
    if (argv[1] === "stop" && argv[2] === "nginx.service") {
      stops += 1;
      control.inflight = hung;
      return hung;
    }
    if (argv[1] === "show") return Promise.resolve({ code: 0, stdout: show("up") });
    return Promise.resolve({ code: 0, stdout: "" });
  };
  const ac = new AbortController();
  h.deps.signal = ac.signal;
  h.deps.sleep = async () => {
    ac.abort();
  };
  const first = await stopServices(h.deps);
  assert.equal(stops, 1);
  assert.equal(first.servicesStopped, false);
  assert.ok(first.notStopped.includes("nginx"));
  assert.equal(h.logs.some((line) => line.includes("cancel")), false);

  const ac2 = new AbortController();
  h.deps.signal = ac2.signal;
  h.deps.sleep = async () => {
    ac2.abort();
  };
  const second = await stopServices(h.deps);
  assert.equal(stops, 1);
  assert.ok(second.notStopped.includes("nginx"));
  release({ code: 0, stdout: "" });
  await hung;
});

test("already stopped nginx is idempotent and an unknown unit is not_applicable", async () => {
  const h = harness();
  h.units["nginx.service"] = "down";
  h.units["redis-server.service"] = "missing";
  h.setProcesses([proc("msg", 31), proc("msg", 32), proc("msg-worker", 40)]);
  delete h.units["postgresql@17-main.service"];
  h.units["postgresql.service"] = "missing";
  const report = await stopServices(h.deps);
  assert.equal(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "nginx.service"), false);
  const nginx = report.effects.find((item) => item.name === "nginx");
  const redis = report.effects.find((item) => item.name === "redis-server");
  assert.equal(nginx.result, "stopped");
  assert.equal(redis.result, "not_applicable");
  assert.equal(report.servicesStopped, true);
});

test("a backward wall clock does not extend the monotonic budget", async () => {
  const h = harness();
  let jumps = 0;
  h.deps.now = () => {
    jumps += 1;
    return jumps > 3 ? 1_000_000 - 50_000 : 1_000_000;
  };
  h.deps.mono = () => (jumps > 3 ? 120_000 : 0);
  h.deps.selfDeadlineAt = 1_000_000 + 60_000 + 5_000;
  const report = await stopServices(h.deps);
  assert.equal(report.servicesStopped, false);
  assert.equal(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "redis-server.service"), false);
});

test("a bad unit name from list-units is unconfirmed and not stopped", async () => {
  const h = harness();
  h.setProcesses([]);
  h.units["nginx.service"] = "down";
  h.units["redis-server.service"] = "down";
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv[1] === "list-units") {
      h.calls.push(argv.slice());
      return Promise.resolve({ code: 0, stdout: "postgresql@bad name.service loaded active running\n" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.equal(report.servicesStopped, false);
  assert.ok(report.notStopped.includes("postgresql"));
  assert.equal(h.calls.some((argv) => argv[1] === "stop" && String(argv[2] || "").includes("bad")), false);
});

test("a daemon that vanishes between reads is unconfirmed and does not autostart", async () => {
  const h = harness();
  let lists = 0;
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("list") && argv.some((arg) => String(arg).includes("pm2-readonly.mjs"))) {
      lists += 1;
      h.calls.push(argv.slice());
      if (lists === 1) return Promise.resolve({ code: 0, stdout: JSON.stringify(h.getProcesses()) });
      return Promise.resolve({ code: 3, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.equal(lists >= 2, true);
  assert.equal(report.servicesStopped, false);
  assert.ok(report.notStopped.includes("pm2") || report.notStopped.includes("app-b"));
  assert.equal(h.calls.some((argv) => argv.includes("jlist") || argv.includes("start")), false);
  assert.equal(h.calls.some((argv) => argv[1] === "stop" && argv[2] === "redis-server.service"), false);
});

test("an unknown pm2 target is an unconfirmed inventory, not an exception", async () => {
  for (const target of [{ pm2User: undefined, pm2Home: undefined }, { pm2User: "collab", pm2Home: "" }]) {
    const h = harness(target);
    const report = await stopServices(h.deps);
    assert.equal(report.servicesStopped, false);
    assert.ok(report.notStopped.includes("pm2"));
    assert.equal(h.calls.some((argv) => argv.includes("jlist") || argv.includes("list") || argv.includes("pm2")), false);
    const redisStop = h.calls.some((argv) => argv[1] === "stop" && argv[2] === "redis-server.service");
    assert.equal(redisStop, false, "redis is only observed while apps are unconfirmed");
  }
});

// rt123 s13: the VM shutdown consumes the shared PM2-only order (scripts/pm2-stop-order.mjs).

function pm2Stops(calls) {
  return calls.filter((argv) => argv.includes("pm2") && argv.includes("stop")).map((argv) => argv[argv.length - 1]);
}

function noDataStop(calls) {
  return !calls.some((argv) => argv[1] === "stop" && (argv[2] === "redis-server.service" || String(argv[2] || "").startsWith("postgresql@")));
}

test("s13: same order as s11, a pm2 module is never stopped nor counted, identities are kernel ones", async () => {
  const h = harness();
  h.setProcesses([
    proc("app-b", 20),
    proc("app-a", 21),
    proc("msg", 31),
    proc("msg", 32),
    proc("msg-worker", 40),
    { name: "pm2-logrotate", pm_id: 9, pid: 50, pm2_env: { status: "online", pm_uptime: 50, pmx_module: true } },
  ]);
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), ["app-a", "app-b", "msg-worker", "msg"]);
  assert.equal(report.servicesStopped, true);
  assert.equal(report.notStopped.includes("pm2-logrotate"), false);
  assert.equal(report.stopped.includes("pm2-logrotate"), false);
  const msg = report.effects.find((item) => item.name === "msg" && item.stage === "msg");
  assert.deepEqual(msg.identities.map((id) => id.startTime).sort(), [kernelStart(31), kernelStart(32)].sort());
  assert.ok(msg.identities.every((id) => id.bootId === "boot-1"));
  assert.ok(report.effects.some((item) => item.stage === "pm2-confirm" && item.result === "stopped"));
  assert.ok(h.intents.some((intent) => intent.stage === "pm2-apps" && intent.requestId === REQUEST));
});

test("s13: a pending app keeps msg-worker and msg without stop and keeps the data services", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      h.calls.push(argv.slice());
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), ["app-b"]);
  assert.equal(report.servicesStopped, false);
  for (const name of ["app-b", "msg-worker", "msg"]) assert.ok(report.notStopped.includes(name), name);
  const worker = report.effects.find((item) => item.name === "msg-worker");
  assert.equal(worker.result, "unconfirmed");
  assert.equal(worker.reason, "dependency");
  assert.ok(noDataStop(h.calls));
});

test("s13: a pending worker keeps msg without stop", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "msg-worker") {
      h.calls.push(argv.slice());
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), ["app-b", "msg-worker"]);
  assert.ok(report.stopped.includes("app-b"));
  assert.ok(report.notStopped.includes("msg"));
  assert.equal(report.effects.find((item) => item.name === "msg").reason, "dependency");
  assert.ok(noDataStop(h.calls));
});

test("s13: a row gone from the list with its pid alive holds the next phase until the kernel says gone", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  let polls = 0;
  let appAliveAtWorkerStop = null;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      h.calls.push(argv.slice());
      h.setProcesses(h.getProcesses().filter((row) => row.name !== "app-b"));
      h.kernel().set(20, { startTime: kernelStart(20), uid: 1001 });
      return Promise.resolve({ code: 0, stdout: "" });
    }
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "msg-worker") {
      appAliveAtWorkerStop = h.kernel().has(20);
    }
    return realExec(argv);
  };
  const realSleep = h.deps.sleep;
  h.deps.sleep = async (ms) => {
    polls += 1;
    if (polls === 3) h.kernel().delete(20);
    await realSleep(ms);
  };
  const report = await stopServices(h.deps);
  assert.equal(appAliveAtWorkerStop, false);
  assert.ok(polls >= 3);
  assert.deepEqual(pm2Stops(h.calls), ["app-b", "msg-worker", "msg"]);
  assert.equal(report.servicesStopped, true);
});

test("s13: a reused pid is not the old process; a new instance of the phase keeps it open", async () => {
  const reused = harness();
  const realReused = reused.deps.exec;
  reused.deps.exec = (argv) => {
    const out = realReused(argv);
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      reused.kernel().set(20, { startTime: kernelStart(20) + 1, uid: 0 });
    }
    return out;
  };
  const first = await stopServices(reused.deps);
  assert.deepEqual(pm2Stops(reused.calls), ["app-b", "msg-worker", "msg"]);
  assert.ok(first.stopped.includes("app-b"));

  const respawn = harness();
  const realRespawn = respawn.deps.exec;
  respawn.deps.exec = (argv) => {
    const out = realRespawn(argv);
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      respawn.setProcesses(respawn.getProcesses().concat([proc("app-b", 22)]));
    }
    return out;
  };
  const second = await stopServices(respawn.deps);
  assert.deepEqual(pm2Stops(respawn.calls), ["app-b"]);
  assert.ok(second.notStopped.includes("app-b"));
  assert.ok(second.effects.find((item) => item.name === "app-b").identities.some((id) => id.pid === 22));
  assert.ok(noDataStop(respawn.calls));
});

test("s13: a /proc read error is unconfirmed, not gone", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      h.calls.push(argv.slice());
      h.setProcesses(h.getProcesses().filter((row) => row.name !== "app-b"));
      h.kernel().set(20, { error: "EACCES" });
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), ["app-b"]);
  assert.ok(report.notStopped.includes("app-b"));
  assert.ok(h.logs.some((line) => line.includes("error=EACCES")));
  assert.ok(noDataStop(h.calls));
});

test("s13: originally absent phases are not_applicable; a listed pid already gone is absent", async () => {
  const h = harness();
  h.setProcesses([proc("app-b", 20), proc("msg", 31)]);
  h.kernel().delete(20);
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), ["msg"]);
  assert.equal(report.effects.find((item) => item.name === "msg-worker").result, "not_applicable");
  assert.equal(report.servicesStopped, true);
});

test("s13: an in-flight pm2 stop is waited and re-issued only while an instance lives", async () => {
  for (const alive of [true, false]) {
    const h = harness();
    h.units["nginx.service"] = "down";
    // The in-flight command (a previous run) finishes app-b before the first observation.
    const realExec = h.deps.exec;
    let lists = 0;
    h.deps.exec = (argv) => {
      if (argv.includes("list") && argv.some((arg) => String(arg).includes("pm2-readonly.mjs"))) {
        lists += 1;
        if (!alive && lists === 2) {
          h.kernel().delete(20);
          h.setProcesses(h.getProcesses().filter((row) => row.name !== "app-b"));
        }
      }
      return realExec(argv);
    };
    h.control.inflight = Promise.resolve({ code: 0, stdout: "" });
    const report = await stopServices(h.deps);
    const appStops = pm2Stops(h.calls).filter((name) => name === "app-b");
    assert.equal(appStops.length, alive ? 1 : 0, `alive=${alive}`);
    assert.equal(report.servicesStopped, true);
  }
});

test("s13: a reserved app name is never sent to pm2 and blocks the platform", async () => {
  const h = harness();
  h.setProcesses([proc("all", 20), proc("msg-worker", 40), proc("msg", 31)]);
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), []);
  assert.ok(report.notStopped.includes("all"));
  assert.ok(report.notStopped.includes("msg"));
  assert.ok(noDataStop(h.calls));
});

test("s13: a boot_id that changes during a phase is unconfirmed", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (argv) => {
    if (argv.includes("pm2") && argv.includes("stop") && argv[argv.length - 1] === "app-b") {
      h.setBootId("boot-2");
    }
    return realExec(argv);
  };
  const report = await stopServices(h.deps);
  assert.deepEqual(pm2Stops(h.calls), ["app-b"]);
  assert.equal(report.effects.find((item) => item.name === "app-b").result, "unconfirmed");
  assert.ok(report.notStopped.includes("msg"));
  assert.ok(noDataStop(h.calls));
});
