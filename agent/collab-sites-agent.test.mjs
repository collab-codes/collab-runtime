import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_VERSION,
  argValue,
  buildHeartbeatBody,
  buildStatusBody,
  configFromValues,
  loadConfig,
  meminfoMbFrom,
  parseEnvFile,
  requestAllowed,
  routeStatusRequest,
  run,
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
  assert.equal(AGENT_VERSION, "0.3.0");
});
