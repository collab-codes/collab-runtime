import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_VERSION,
  argValue,
  buildHeartbeatBody,
  buildStatusBody,
  buildStatusPayload,
  configFromValues,
  frozenShutdownReport,
  loadConfig,
  meminfoMbFrom,
  parseEnvFile,
  pm2FactsFrom,
  pm2Jlist,
  requestAllowed,
  routeStatusRequest,
  run,
  runtimeStatusFrom,
  sendHeartbeat,
} from "./collab-sites-agent.mjs";

const FIXTURE_ENV = `
# comment
COLLAB_SITES_URL=https://sites.collab.codes/
COLLAB_SITES_SERVER_ID=srv_102052
COLLAB_SITES_PROJECT_ID=102052
COLLAB_SITES_AGENT_TOKEN=tok_fixture
COLLAB_SITES_AGENT_BIND=127.0.0.1:5151
COLLAB_SITES_ALLOWED_ORIGIN=sites.collab.codes
COLLAB_SITES_HEARTBEAT_INTERVAL_SECONDS=30
COLLAB_SITES_DATA_ROOT=/data
COLLAB_SITES_RUNTIME_DIR=/data/collab-runtime
COLLAB_SITES_REGION=us-east-1
COLLAB_SITES_INSTANCE_ID=i-fixture
COLLAB_SITES_INSTANCE_ID_FROM_IMDS=false
COLLAB_SITES_AGENT_VERSION=0.3.0
`;

const FACTS = {
  hostname: "ip-10-0-0-5",
  loadavg: "0.12 0.08 0.05 1/120 99",
  disk: "Filesystem Size Used Avail Use% Mounted on\n/dev/nvme1n1 32G 4G 28G 13% /data",
  cpus: 2,
  memTotalMb: 3902,
  memAvailableMb: 2064,
  collabStatus: "nginx: active",
  services: { nginx: "active", postgresql: "active", redis: "active" },
  pm2: {
    dump: "present",
    expected: ["app"],
    processes: [{ name: "app", status: "online" }],
  },
  runtimeStatus: "ready",
  runtimeVersion: "abc1234",
};

const MEMINFO = "MemTotal:        3996412 kB\nMemFree:          201884 kB\nMemAvailable:    2113664 kB\nBuffers:           12345 kB\n";

function writeEnv(content = FIXTURE_ENV) {
  const dir = mkdtempSync(join(tmpdir(), "sites-agent-"));
  const path = join(dir, "sites-agent.env");
  writeFileSync(path, content);
  return path;
}

test("parseEnvFile skips comments, blanks and strips quotes", () => {
  const values = parseEnvFile(FIXTURE_ENV);
  assert.equal(values.COLLAB_SITES_URL, "https://sites.collab.codes/");
  assert.equal(values.COLLAB_SITES_SERVER_ID, "srv_102052");
  assert.equal(values["# comment"], undefined);
  const quoted = parseEnvFile("COLLAB_SITES_URL='https://sites.collab.codes'\nCOLLAB_SITES_TOKEN=\"abc\"\n");
  assert.equal(quoted.COLLAB_SITES_URL, "https://sites.collab.codes");
  assert.equal(quoted.COLLAB_SITES_TOKEN, "abc");
});

test("configFromValues reads the env contract and defaults", async () => {
  const values = parseEnvFile(FIXTURE_ENV);
  const config = await configFromValues(values, {
    metadataInstanceId: async () => {
      throw new Error("IMDS must not be called when instance id is set");
    },
  });
  assert.equal(config.sitesUrl, "https://sites.collab.codes");
  assert.equal(config.serverId, "srv_102052");
  assert.equal(config.projectId, "102052");
  assert.equal(config.token, "tok_fixture");
  assert.equal(config.bind, "127.0.0.1:5151");
  assert.equal(config.allowedOrigin, "sites.collab.codes");
  assert.equal(config.interval, 30);
  assert.equal(config.dataRoot, "/data");
  assert.equal(config.runtimeDir, "/data/collab-runtime");
  assert.equal(config.region, "us-east-1");
  assert.equal(config.instanceId, "i-fixture");
  assert.equal(config.agentVersion, "0.3.0");
});

test("configFromValues requires the sites identity keys", async () => {
  const values = parseEnvFile(FIXTURE_ENV);
  delete values.COLLAB_SITES_AGENT_TOKEN;
  await assert.rejects(() => configFromValues(values), /COLLAB_SITES_AGENT_TOKEN is required/);
});

test("configFromValues looks up IMDS only when instance id is empty", async () => {
  const values = parseEnvFile(FIXTURE_ENV);
  values.COLLAB_SITES_INSTANCE_ID = "";
  values.COLLAB_SITES_INSTANCE_ID_FROM_IMDS = "true";
  const config = await configFromValues(values, { metadataInstanceId: async () => "i-from-imds" });
  assert.equal(config.instanceId, "i-from-imds");

  values.COLLAB_SITES_INSTANCE_ID_FROM_IMDS = "false";
  const skipped = await configFromValues(values, {
    metadataInstanceId: async () => {
      throw new Error("IMDS disabled");
    },
  });
  assert.equal(skipped.instanceId, "");
});

test("loadConfig reads a fixture env file", async () => {
  const path = writeEnv();
  const config = await loadConfig(path);
  assert.equal(config.projectId, "102052");
  assert.equal(config.instanceId, "i-fixture");
});

test("heartbeat body keeps every field the sites server already consumes", async () => {
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  const body = buildHeartbeatBody(config, FACTS);
  assert.deepEqual(Object.keys(body), [
    "projectId",
    "instanceId",
    "token",
    "status",
    "runtimeVersion",
    "agentVersion",
    "payload",
  ]);
  assert.equal(body.projectId, "102052");
  assert.equal(body.instanceId, "i-fixture");
  assert.equal(body.token, "tok_fixture");
  assert.equal(body.status, "ready");
  assert.equal(body.runtimeVersion, "abc1234");
  assert.equal(body.agentVersion, "0.3.0");
  assert.deepEqual(Object.keys(body.payload), [
    "hostname",
    "region",
    "dataRoot",
    "runtimeDir",
    "loadavg",
    "disk",
    "cpus",
    "memTotalMb",
    "memAvailableMb",
    "collabStatus",
    "services",
    "pm2",
  ]);
  assert.equal(body.payload.hostname, "ip-10-0-0-5");
  assert.equal(body.payload.region, "us-east-1");
  assert.equal(body.payload.dataRoot, "/data");
  assert.equal(body.payload.runtimeDir, "/data/collab-runtime");
  assert.equal(body.payload.loadavg, FACTS.loadavg);
  assert.equal(body.payload.disk, FACTS.disk);
  assert.equal(body.payload.cpus, 2);
  assert.equal(body.payload.memTotalMb, 3902);
  assert.equal(body.payload.memAvailableMb, 2064);
  assert.equal(body.payload.collabStatus, "nginx: active");
  assert.deepEqual(body.payload.services, { nginx: "active", postgresql: "active", redis: "active" });
  assert.deepEqual(body.payload.pm2, {
    dump: "present",
    expected: ["app"],
    processes: [{ name: "app", status: "online" }],
  });
});

const INFRA_UP = { nginx: "active", postgresql: "active", redis: "active" };

test("runtimeStatus is ready when there is no dump (VM without an app)", () => {
  const pm2 = pm2FactsFrom(null, "[]");
  assert.equal(pm2.dump, "absent");
  assert.deepEqual(pm2.expected, []);
  assert.equal(runtimeStatusFrom(INFRA_UP, pm2), "ready");
});

test("runtimeStatus stays ready when the dump only has pm2-logrotate", () => {
  const pm2 = pm2FactsFrom(JSON.stringify([{ name: "pm2-logrotate" }]), "[]");
  assert.equal(pm2.dump, "present");
  assert.deepEqual(pm2.expected, []);
  assert.equal(runtimeStatusFrom(INFRA_UP, pm2), "ready");
});

test("runtimeStatus is degraded when the dump expects apps and none are online", () => {
  const pm2 = pm2FactsFrom(JSON.stringify([{ name: "app" }]), "[]");
  assert.equal(pm2.dump, "present");
  assert.deepEqual(pm2.expected, ["app"]);
  assert.deepEqual(pm2.processes, [{ name: "app", status: "missing" }]);
  assert.equal(runtimeStatusFrom(INFRA_UP, pm2), "degraded");
});

test("runtimeStatus is degraded when an expected app is errored", () => {
  const pm2 = pm2FactsFrom(
    JSON.stringify([{ name: "app" }]),
    JSON.stringify([{ name: "app", pm2_env: { status: "errored" } }]),
  );
  assert.equal(runtimeStatusFrom(INFRA_UP, pm2), "degraded");
});

test("runtimeStatus is ready when dump apps are online", () => {
  const pm2 = pm2FactsFrom(
    JSON.stringify([{ name: "app" }, { name: "pm2-logrotate" }]),
    JSON.stringify([{ name: "app", pm2_env: { status: "online" } }]),
  );
  assert.deepEqual(pm2.expected, ["app"]);
  assert.equal(runtimeStatusFrom(INFRA_UP, pm2), "ready");
});

test("status body keeps serverId and the same payload shape", async () => {
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  const body = buildStatusBody(config, FACTS);
  assert.deepEqual(Object.keys(body), ["serverId", "projectId", "instanceId", "status", "payload"]);
  assert.equal(body.serverId, "srv_102052");
  assert.equal(body.payload.services.redis, "active");
});

test("status server routes /health /status 404 and 403 of origin", async () => {
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  const allowed = { origin: "https://sites.collab.codes" };

  const health = routeStatusRequest({ path: "/health", headers: allowed, config, facts: FACTS });
  assert.equal(health.status, 200);
  assert.equal(health.body, JSON.stringify({ status: "ok" }));

  const status = routeStatusRequest({ path: "/status", headers: allowed, config, facts: FACTS });
  assert.equal(status.status, 200);
  const parsed = JSON.parse(status.body);
  assert.equal(parsed.serverId, "srv_102052");
  assert.equal(parsed.payload.hostname, "ip-10-0-0-5");

  const missing = routeStatusRequest({ path: "/nope", headers: allowed, config, facts: FACTS });
  assert.equal(missing.status, 404);
  assert.equal(missing.body, JSON.stringify({ error: "not found" }));

  const forbidden = routeStatusRequest({ path: "/health", headers: {}, config, facts: FACTS });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body, JSON.stringify({ error: "origin not allowed" }));

  const wrong = routeStatusRequest({
    path: "/health",
    headers: { origin: "https://evil.example" },
    config,
    facts: FACTS,
  });
  assert.equal(wrong.status, 403);

  const collabHeader = routeStatusRequest({
    path: "/health",
    headers: { "x-collab-origin": "sites.collab.codes" },
    config,
    facts: FACTS,
  });
  assert.equal(collabHeader.status, 200);
});

test("requestAllowed strips http(s) prefixes the way the rust agent did", () => {
  assert.equal(requestAllowed({ origin: "https://sites.collab.codes" }, "sites.collab.codes"), true);
  assert.equal(requestAllowed({ origin: "http://sites.collab.codes" }, "https://sites.collab.codes"), true);
  assert.equal(requestAllowed({ "x-collab-origin": "sites.collab.codes" }, "sites.collab.codes"), true);
  assert.equal(requestAllowed({}, "sites.collab.codes"), false);
});

test("meminfo reads MiB and ignores unknown keys", () => {
  assert.equal(meminfoMbFrom(MEMINFO, "MemTotal"), 3902);
  assert.equal(meminfoMbFrom(MEMINFO, "MemAvailable"), 2064);
  assert.equal(meminfoMbFrom(MEMINFO, "SwapTotal"), null);
  assert.equal(meminfoMbFrom("garbage without colon\n", "MemTotal"), null);
});

test("--once sends exactly one heartbeat with the injected post", async () => {
  const path = writeEnv();
  const calls = [];
  await run(["--env", path, "--once"], {
    collectFacts: () => FACTS,
    readShutdownState: async () => ({ status: "absent" }),
    postJson: async (url, opts) => {
      calls.push({ url, opts });
      return { statusCode: 200, body: "{}" };
    },
    metadataInstanceId: async () => {
      throw new Error("IMDS must not run in --once fixture");
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sites.collab.codes/api/v1/servers/srv_102052/heartbeat");
  assert.equal(calls[0].opts.headers["X-Collab-Origin"], "collab-runtime-agent");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.projectId, "102052");
  assert.equal(body.instanceId, "i-fixture");
  assert.equal(body.token, "tok_fixture");
  assert.equal(body.payload.services.nginx, "active");
});

test("argValue reads --env <path>", () => {
  assert.equal(argValue(["--env", "/tmp/x.env", "--once"], "--env"), "/tmp/x.env");
  assert.equal(argValue(["--once"], "--env"), undefined);
});

test("default agent version is the Node rewrite", () => {
  assert.equal(AGENT_VERSION, "0.3.1");
});

/**
 * rt27. Este agente roda como ROOT, e qualquer comando `pm2` SOBE um daemon quando nao ha' nenhum.
 * No boot ele corre com o `pm2-<user>.service`: ganhando a corrida, criava o God Daemon sobre o
 * PM2_HOME do deploy user com os sockets de root, e o servico do usuario nunca mais subia — VM sem
 * app e dominio em 502 (medido na 102056 em 23/09/2026). A guarda e' nao tocar no `pm2` enquanto o
 * daemon nao existir.
 */
test("pm2Jlist nao invoca o pm2 quando o daemon nao existe (nao cria daemon no boot)", () => {
  const home = mkdtempSync(join(tmpdir(), "pm2home-"));
  assert.equal(pm2Jlist(home), null);
});

const REPORT = {
  requestId: "11111111-1111-4111-8111-111111111111",
  stopped: ["nginx", "msg"],
  notStopped: ["postgresql@14-main.service"],
  startedAt: "2026-10-21T23:00:00.000Z",
  finishedAt: "2026-10-21T23:10:00.000Z",
};

function activeState(report) {
  return {
    status: "active",
    record: {
      requestId: REPORT.requestId,
      phase: report ? "services_stopped" : "stopping",
      seq: 4,
      report: report ?? null,
    },
  };
}

test("frozen report is the only shutdown projection and stays idempotent", async () => {
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  const absent = buildHeartbeatBody(config, FACTS, await frozenShutdownReport({
    readShutdownState: async () => ({ status: "absent" }),
  }));
  assert.equal(absent.status, "ready");
  assert.equal(absent.payload.shutdown, undefined);
  assert.equal(Object.hasOwn(absent.payload, "shutdown"), false);

  const active = buildHeartbeatBody(config, FACTS, await frozenShutdownReport({
    bootId: "boot-a",
    readShutdownState: async () => activeState(null),
  }));
  assert.equal(active.status, "ready");
  assert.equal(active.payload.shutdown, undefined);

  const finalReport = await frozenShutdownReport({
    bootId: "boot-a",
    readShutdownState: async () => activeState(REPORT),
  });
  const first = buildHeartbeatBody(config, FACTS, finalReport);
  const second = buildHeartbeatBody(config, FACTS, finalReport);
  assert.equal(first.status, "shutdown_ready");
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.payload.shutdown), [
    "requestId",
    "stopped",
    "notStopped",
    "startedAt",
    "finishedAt",
  ]);
  assert.deepEqual(first.payload.shutdown, REPORT);
  assert.equal(JSON.stringify(first.payload.shutdown).includes("tok_fixture"), false);
  assert.equal(JSON.stringify(first.payload.shutdown).includes("seq"), false);

  const previous = await frozenShutdownReport({
    bootId: "boot-b",
    readShutdownState: async () => ({ status: "other_boot", record: activeState(REPORT).record }),
  });
  assert.equal(previous, null);
  const lateHealth = buildHeartbeatBody(config, FACTS, previous);
  assert.equal(lateHealth.status, "ready");
  assert.equal(lateHealth.payload.shutdown, undefined);

  const kept = buildHeartbeatBody(config, FACTS, finalReport);
  assert.deepEqual(kept.payload.shutdown, first.payload.shutdown);
  assert.equal(kept.status, "shutdown_ready");
});

test("invalid shutdown state is a diagnostic and never a clean stop report", async () => {
  const lines = [];
  const orig = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    const report = await frozenShutdownReport({
      readShutdownState: async () => ({ status: "invalid", reason: "malformed" }),
    });
    assert.equal(report, null);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(lines, ["shutdown state invalid: malformed"]);
  assert.equal(lines.join("").includes("tok_fixture"), false);
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  const body = buildStatusPayload(config, FACTS, null);
  assert.equal(body.shutdown, undefined);
});

test("concurrent heartbeats keep one immutable report and a late health beat does not replace it", async () => {
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const sent = [];
  const readShutdownState = async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      return activeState(REPORT);
    }
    return { status: "absent" };
  };
  const postJson = async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { statusCode: 200, body: "{}" };
  };
  const pending = Promise.all([
    sendHeartbeat(config, { collectFacts: () => FACTS, readShutdownState, postJson, bootId: "boot-a" }),
    sendHeartbeat(config, { collectFacts: () => FACTS, readShutdownState, postJson, bootId: "boot-a" }),
  ]);
  release();
  await pending;
  assert.equal(sent.length, 2);
  const withReport = sent.filter((body) => body.payload.shutdown);
  const without = sent.filter((body) => !body.payload.shutdown);
  assert.equal(withReport.length, 1);
  assert.equal(without.length, 1);
  assert.equal(withReport[0].status, "shutdown_ready");
  assert.deepEqual(withReport[0].payload.shutdown, REPORT);
  assert.equal(without[0].status, "ready");
  assert.equal(withReport[0].token, "tok_fixture");
  assert.equal(Object.hasOwn(withReport[0].payload.shutdown, "token"), false);
  const again = await frozenShutdownReport({
    bootId: "boot-a",
    readShutdownState: async () => activeState(REPORT),
  });
  assert.deepEqual(buildHeartbeatBody(config, FACTS, again).payload.shutdown, REPORT);
});

test("status route has no shutdown command and publishes the frozen report only", async () => {
  const config = await configFromValues(parseEnvFile(FIXTURE_ENV));
  const allowed = { origin: "https://sites.collab.codes" };
  const plain = routeStatusRequest({ path: "/status", headers: allowed, config, facts: FACTS });
  assert.equal(JSON.parse(plain.body).payload.shutdown, undefined);
  const posted = routeStatusRequest({ path: "/shutdown", headers: allowed, config, facts: FACTS });
  assert.equal(posted.status, 404);
  const ready = routeStatusRequest({
    path: "/status",
    headers: allowed,
    config,
    facts: FACTS,
    shutdown: REPORT,
  });
  const parsed = JSON.parse(ready.body);
  assert.equal(parsed.status, "ready");
  assert.deepEqual(parsed.payload.shutdown, REPORT);
});

test("importing the agent does not open the status listener", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ["--input-type=module", "-e", "await import('./collab-sites-agent.mjs')"], {
    cwd: here,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
});
