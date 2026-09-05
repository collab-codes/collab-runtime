#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT_VERSION = "0.3.0";
export const DEFAULT_ENV_PATH = "/etc/collab/sites-agent.env";
export const DEFAULT_BIND = "127.0.0.1:5151";
export const DEFAULT_ALLOWED_ORIGIN = "sites.collab.codes";
export const HEARTBEAT_ORIGIN = "collab-runtime-agent";

export function parseEnvFile(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function argValue(args, name) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === name) return args[i + 1];
  }
  return undefined;
}

export function meminfoMbFrom(content, key) {
  if (!content) return null;
  for (const line of content.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim() !== key) continue;
    const kb = Number.parseInt(line.slice(colon + 1).trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(kb)) return null;
    return Math.floor(kb / 1024);
  }
  return null;
}

export function cpuCount() {
  try {
    if (typeof os.availableParallelism === "function") return os.availableParallelism();
  } catch {
    // fall through
  }
  const cpus = os.cpus();
  return cpus.length > 0 ? cpus.length : null;
}

function required(values, key) {
  const value = values[key];
  if (value == null || value === "") throw new Error(`${key} is required`);
  return value;
}

function stripOrigin(value) {
  return value.trim().replace(/^https:\/\//, "").replace(/^http:\/\//, "");
}

export function requestAllowed(headers, allowedOrigin) {
  const normalized = stripOrigin(allowedOrigin ?? "");
  const origin = headers.origin ?? headers.Origin;
  const collabOrigin = headers["x-collab-origin"] ?? headers["X-Collab-Origin"];
  const originHost = origin != null ? stripOrigin(String(origin)) : undefined;
  const collabHost = collabOrigin != null ? stripOrigin(String(collabOrigin)) : undefined;
  return originHost === normalized || collabHost === normalized;
}

export function requestPath(urlPath) {
  return (urlPath ?? "/").split("?")[0] || "/";
}

export async function configFromValues(values, deps = {}) {
  const sitesUrl = required(values, "COLLAB_SITES_URL").replace(/\/+$/, "");
  let instanceId = values.COLLAB_SITES_INSTANCE_ID ?? "";
  const fromImds = (values.COLLAB_SITES_INSTANCE_ID_FROM_IMDS ?? "true") === "true";
  if (!instanceId && fromImds) {
    const lookup = deps.metadataInstanceId ?? metadataInstanceId;
    instanceId = (await lookup(deps)) || "";
  }
  const intervalRaw = values.COLLAB_SITES_HEARTBEAT_INTERVAL_SECONDS;
  const interval = Number.parseInt(intervalRaw ?? "", 10);
  return {
    sitesUrl,
    serverId: required(values, "COLLAB_SITES_SERVER_ID"),
    projectId: required(values, "COLLAB_SITES_PROJECT_ID"),
    token: required(values, "COLLAB_SITES_AGENT_TOKEN"),
    bind: values.COLLAB_SITES_AGENT_BIND || DEFAULT_BIND,
    allowedOrigin: values.COLLAB_SITES_ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 30,
    dataRoot: values.COLLAB_SITES_DATA_ROOT || "/data",
    runtimeDir: values.COLLAB_SITES_RUNTIME_DIR || "/data/collab-runtime",
    region: values.COLLAB_SITES_REGION || "",
    instanceId,
    agentVersion: values.COLLAB_SITES_AGENT_VERSION || AGENT_VERSION,
  };
}

export async function loadConfig(path, deps = {}) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
  return configFromValues(parseEnvFile(content), deps);
}

export function commandOutput(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 8000 });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function systemdStatus(service) {
  return commandOutput("systemctl", ["is-active", service]) ?? "unknown";
}

export function collectFacts(config) {
  const nginx = systemdStatus("nginx");
  const postgresql = systemdStatus("postgresql");
  const redis = systemdStatus("redis-server");
  let loadavg = "";
  try {
    loadavg = readFileSync("/proc/loadavg", "utf8").trim();
  } catch {
    loadavg = "";
  }
  let meminfo = "";
  try {
    meminfo = readFileSync("/proc/meminfo", "utf8");
  } catch {
    meminfo = "";
  }
  return {
    hostname: commandOutput("hostname", []) ?? "",
    loadavg,
    disk: commandOutput("df", ["-h", config.dataRoot]) ?? "",
    cpus: cpuCount(),
    memTotalMb: meminfoMbFrom(meminfo, "MemTotal"),
    memAvailableMb: meminfoMbFrom(meminfo, "MemAvailable"),
    collabStatus: commandOutput("collab", ["status"]) ?? "collab status unavailable",
    services: { nginx, postgresql, redis },
    runtimeStatus: nginx === "active" && postgresql === "active" && redis === "active" ? "ready" : "degraded",
    runtimeVersion:
      commandOutput("git", ["-C", config.runtimeDir, "rev-parse", "--short", "HEAD"]) ?? "unknown",
  };
}

export function buildStatusPayload(config, facts) {
  return {
    hostname: facts.hostname ?? "",
    region: config.region,
    dataRoot: config.dataRoot,
    runtimeDir: config.runtimeDir,
    loadavg: facts.loadavg ?? "",
    disk: facts.disk ?? "",
    cpus: facts.cpus ?? null,
    memTotalMb: facts.memTotalMb ?? null,
    memAvailableMb: facts.memAvailableMb ?? null,
    collabStatus: facts.collabStatus ?? "collab status unavailable",
    services: {
      nginx: facts.services?.nginx ?? "unknown",
      postgresql: facts.services?.postgresql ?? "unknown",
      redis: facts.services?.redis ?? "unknown",
    },
  };
}

export function buildHeartbeatBody(config, facts) {
  return {
    projectId: config.projectId,
    instanceId: config.instanceId,
    token: config.token,
    status: facts.runtimeStatus,
    runtimeVersion: facts.runtimeVersion,
    agentVersion: config.agentVersion,
    payload: buildStatusPayload(config, facts),
  };
}

export function buildStatusBody(config, facts) {
  return {
    serverId: config.serverId,
    projectId: config.projectId,
    instanceId: config.instanceId,
    status: facts.runtimeStatus,
    payload: buildStatusPayload(config, facts),
  };
}

export function routeStatusRequest({ path, headers, config, facts }) {
  if (!requestAllowed(headers ?? {}, config.allowedOrigin)) {
    return { status: 403, body: JSON.stringify({ error: "origin not allowed" }) };
  }
  switch (requestPath(path)) {
    case "/health":
      return { status: 200, body: JSON.stringify({ status: "ok" }) };
    case "/status":
      return { status: 200, body: JSON.stringify(buildStatusBody(config, facts)) };
    default:
      return { status: 404, body: JSON.stringify({ error: "not found" }) };
  }
}

export function httpRequest(urlString, { method = "GET", headers = {}, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8").trim(),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function metadataInstanceId(deps = {}) {
  const request = deps.httpRequest ?? httpRequest;
  try {
    const tokenRes = await request("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
      timeoutMs: 2000,
    });
    if (tokenRes.statusCode >= 200 && tokenRes.statusCode < 300 && tokenRes.body) {
      const idRes = await request("http://169.254.169.254/latest/meta-data/instance-id", {
        headers: { "X-aws-ec2-metadata-token": tokenRes.body },
        timeoutMs: 2000,
      });
      if (idRes.statusCode >= 200 && idRes.statusCode < 300 && idRes.body) return idRes.body;
    }
  } catch {
    // IMDSv2 unavailable
  }
  try {
    const fallback = await request("http://169.254.169.254/latest/meta-data/instance-id", {
      timeoutMs: 2000,
    });
    if (fallback.statusCode >= 200 && fallback.statusCode < 300 && fallback.body) return fallback.body;
  } catch {
    // IMDSv1 unavailable
  }
  return "";
}

async function defaultPostJson(url, { headers, body, timeoutMs }) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return httpRequest(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    },
    body: payload,
    timeoutMs,
  });
}

export async function sendHeartbeat(config, deps = {}) {
  const url = `${config.sitesUrl}/api/v1/servers/${config.serverId}/heartbeat`;
  const facts = (deps.collectFacts ?? collectFacts)(config);
  const payload = JSON.stringify(buildHeartbeatBody(config, facts));
  const postJson = deps.postJson ?? defaultPostJson;
  try {
    const result = await postJson(url, {
      headers: {
        "Content-Type": "application/json",
        "X-Collab-Origin": HEARTBEAT_ORIGIN,
      },
      body: payload,
      timeoutMs: 10000,
    });
    if (result.statusCode >= 200 && result.statusCode < 300) {
      console.log(`heartbeat sent to ${url}`);
    } else {
      console.error(`heartbeat failed: status=${result.statusCode} body=${(result.body ?? "").trim()}`);
    }
    return result;
  } catch (err) {
    console.error(`heartbeat failed: ${err.message}`);
    return { statusCode: 0, body: "", error: err };
  }
}

function parseBind(bind) {
  const idx = bind.lastIndexOf(":");
  if (idx <= 0) return { host: "127.0.0.1", port: Number(bind) };
  return { host: bind.slice(0, idx), port: Number(bind.slice(idx + 1)) };
}

export function startStatusServer(config, deps = {}) {
  const server = http.createServer((req, res) => {
    const facts = (deps.collectFacts ?? collectFacts)(config);
    const result = routeStatusRequest({
      path: req.url ?? "/",
      headers: req.headers,
      config,
      facts,
    });
    res.writeHead(result.status, {
      "Content-Type": "application/json",
      Connection: "close",
    });
    res.end(result.body);
  });
  server.on("error", (err) => {
    console.error(`status server bind failed on ${config.bind}: ${err.message}`);
  });
  const { host, port } = parseBind(config.bind);
  server.listen(port, host, () => {
    console.log(`status server listening on ${config.bind}`);
  });
  return server;
}

export async function run(argv, deps = {}) {
  const envPath = argValue(argv, "--env") ?? DEFAULT_ENV_PATH;
  const once = argv.includes("--once");
  const config = await loadConfig(envPath, deps);
  if (once) {
    await sendHeartbeat(config, deps);
    return { config, once: true };
  }
  const server = startStatusServer(config, deps);
  const beat = () => sendHeartbeat(config, deps);
  await beat();
  const timer = setInterval(beat, config.interval * 1000);
  return { config, server, timer, once: false };
}

function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isCliEntry()) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`collab-sites-agent config error: ${err.message}`);
    process.exit(2);
  });
}
