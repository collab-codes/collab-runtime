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
  return { name, pid, pm2_env: { status, pm_uptime: startTime } };
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
    if (argv.includes("jlist")) {
      return Promise.resolve({ code: 0, stdout: JSON.stringify(processes) });
    }
    if (argv.includes("stop") && argv.includes("pm2")) {
      const name = argv[argv.length - 1];
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
    setProcesses: (next) => {
      processes = next;
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
      if (argv.includes("jlist")) return Promise.resolve({ code, stdout: "" });
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
    assert.equal(h.calls.filter((argv) => argv.includes("jlist")).length >= 1, true);
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

test("an unknown pm2 target is an unconfirmed inventory, not an exception", async () => {
  for (const target of [{ pm2User: undefined, pm2Home: undefined }, { pm2User: "collab", pm2Home: "" }]) {
    const h = harness(target);
    const report = await stopServices(h.deps);
    assert.equal(report.servicesStopped, false);
    assert.ok(report.notStopped.includes("pm2"));
    assert.equal(h.calls.some((argv) => argv.includes("jlist") || argv.includes("pm2")), false);
    const redisStop = h.calls.some((argv) => argv[1] === "stop" && argv[2] === "redis-server.service");
    assert.equal(redisStop, false, "redis is only observed while apps are unconfirmed");
  }
});
