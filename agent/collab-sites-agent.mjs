#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readShutdownState, shutdownReportSnapshot } from "./shutdown-state.mjs";
import { listPm2 } from "../scripts/pm2-readonly.mjs";

export const AGENT_VERSION = "0.3.1";
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
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

export function commandOutput(command, args, opts = {}) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 8000, ...opts });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function fileOwner(path) {
  return commandOutput("stat", ["-c", "%U", path]) ?? commandOutput("stat", ["-f", "%Su", path]) ?? "";
}

function pm2ServiceUser() {
  const listed = commandOutput("bash", [
    "-c",
    "find /etc/systemd/system /lib/systemd/system -maxdepth 1 -name 'pm2-*.service' -printf '%f\\n' 2>/dev/null | sort -u",
  ]);
  if (!listed) return "";
  const lines = listed.split("\n").filter(Boolean);
  if (lines.length !== 1) return "";
  const match = /^pm2-(.+)\.service$/.exec(lines[0]);
  return match ? match[1] : "";
}

function resolveDeployUser(dataRoot) {
  const fromUnit = pm2ServiceUser();
  if (fromUnit) return fromUnit;
  const owner = fileOwner(dataRoot);
  if (owner && owner !== "root") return owner;
  if (commandOutput("id", ["-u", "ubuntu"]) != null) return "ubuntu";
  return owner || "";
}

function userHome(user) {
  if (!user) return os.homedir();
  const passwd = commandOutput("getent", ["passwd", user]);
  if (passwd) {
    const home = passwd.split(":")[5];
    if (home) return home;
  }
  if (user === "root") return "/root";
  return `/home/${user}`;
}

export function parsePm2Processes(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.pmx_module === true || entry.pm2_env?.pmx_module === true) continue;
    const name =
      typeof entry.name === "string" && entry.name
        ? entry.name
        : typeof entry.pm2_env?.name === "string"
          ? entry.pm2_env.name
          : "";
    if (!name || name === "pm2-logrotate") continue;
    const status = entry.pm2_env?.status ?? entry.status ?? "unknown";
    out.push({ name, status: String(status) });
  }
  return out;
}

function uniqueNames(processes) {
  const seen = new Set();
  const names = [];
  for (const process of processes) {
    if (seen.has(process.name)) continue;
    seen.add(process.name);
    names.push(process.name);
  }
  return names;
}

function liveStatusFor(live, name) {
  const instances = live.filter((process) => process.name === name);
  if (instances.length === 0) return "missing";
  const bad = instances.find((process) => process.status !== "online");
  return bad ? bad.status : "online";
}

function classifyLive(liveRaw) {
  if (liveRaw == null) return { ok: false, processes: [] };
  let parsed;
  try {
    parsed = JSON.parse(liveRaw);
  } catch {
    return { ok: false, processes: [] };
  }
  if (!Array.isArray(parsed)) return { ok: false, processes: [] };
  return { ok: true, processes: parsePm2Processes(liveRaw) };
}

export function pm2FactsFrom(dumpRaw, liveRaw) {
  const dumpPresent = dumpRaw !== null;
  const expected = uniqueNames(parsePm2Processes(dumpRaw ?? ""));
  const live = classifyLive(liveRaw);
  return {
    dump: dumpPresent ? "present" : "absent",
    expected,
    processes: expected.map((name) => ({ name, status: liveStatusFor(live.processes, name) })),
    live: live.ok ? "ok" : "unavailable",
    liveProcesses: live.processes,
  };
}

export function runtimeStatusFrom(services, pm2) {
  const infra =
    services?.nginx === "active" && services?.postgresql === "active" && services?.redis === "active";
  if (!infra) return "degraded";
  if (pm2?.unit?.activeState !== "active") return "degraded";
  if (pm2?.live !== "ok") return "degraded";
  const rows = Array.isArray(pm2.liveProcesses) ? pm2.liveProcesses : [];
  const ok = rows.every((process) => process != null && process.status === "online");
  return ok ? "ready" : "degraded";
}

const UNKNOWN_UNIT = Object.freeze({
  name: "",
  activeState: "unknown",
  subState: "unknown",
  result: "unknown",
  nRestarts: null,
});

export function pm2UnitFromShow(unitName, raw) {
  if (raw == null || raw === "") {
    return { ...UNKNOWN_UNIT, name: unitName || "" };
  }
  const fields = {};
  for (const line of String(raw).split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  let nRestarts = null;
  if (Object.hasOwn(fields, "NRestarts")) {
    const parsed = Number(fields.NRestarts);
    nRestarts = Number.isFinite(parsed) ? parsed : null;
  }
  return {
    name: fields.Id || unitName || "",
    activeState: fields.ActiveState || "unknown",
    subState: fields.SubState || "unknown",
    result: fields.Result || "unknown",
    nRestarts,
  };
}

export function readPm2Unit(deployUser, command = commandOutput) {
  if (!deployUser || deployUser === "root") return { ...UNKNOWN_UNIT };
  const name = `pm2-${deployUser}.service`;
  const raw = command("systemctl", [
    "show",
    name,
    "-p",
    "Id",
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "Result",
    "-p",
    "NRestarts",
    "--no-pager",
  ]);
  return pm2UnitFromShow(name, raw);
}

export function readBootFacts(readFile = readFileSync) {
  let id = "";
  try {
    id = String(readFile(BOOT_ID_PATH, "utf8") ?? "").trim();
  } catch {
    return null;
  }
  if (!id) return null;
  let uptimeRaw = "";
  try {
    uptimeRaw = String(readFile("/proc/uptime", "utf8") ?? "").trim().split(/\s+/)[0] ?? "";
  } catch {
    return null;
  }
  const uptimeSeconds = Number(uptimeRaw);
  if (!Number.isFinite(uptimeSeconds)) return null;
  return { id, uptimeSeconds };
}

function resolvePm2Bin() {
  if (existsSync("/usr/local/bin/pm2")) return "/usr/local/bin/pm2";
  if (existsSync("/usr/bin/pm2")) return "/usr/bin/pm2";
  return "";
}

function readPm2Dump(pm2Home) {
  try {
    return readFileSync(join(pm2Home, "dump.pm2"), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return "";
  }
}

/**
 * O `jlist` e' opcional: o `dump.pm2` ja' da' a lista esperada. Duas protecoes, porque este agente
 * roda como ROOT e qualquer comando `pm2` SOBE um daemon quando nao consegue falar com um:
 *
 * 1. so' tenta quando o `rpc.sock` existe — no boot, antes do `pm2-<user>.service`, nao existe, e
 *    a' o agente nao encosta no pm2;
 * 2. e mesmo assim chama como o DEPLOY USER, nunca como root.
 *
 * A (2) existe porque a (1) sozinha nao basta: um `rpc.sock` que sobrou de um desligamento sujo faz
 * a (1) passar, e a' o root recria `rpc.sock`/`pub.sock` como root — medido na 102056 em 23/09/2026,
 * com um PM2_HOME de teste: daemons 2 -> 3 e os dois sockets nascendo `root root`. Foi assim que a
 * VM ficou sem app nenhum e o dominio em 502: o `pm2-ubuntu.service` (User=ubuntu) nao consegue mais
 * subir ("Permission denied", 6 tentativas, "Start request repeated too quickly").
 */
export async function pm2Jlist(pm2Home, deployUser = "", deps = {}) {
  if (!pm2Home || !deployUser || deployUser === "root") return null;
  if (!existsSync(join(pm2Home, "rpc.sock"))) return null;
  const pm2Bin = deps.pm2Bin ?? resolvePm2Bin();
  if (!pm2Bin) return null;
  const list = deps.listPm2 ?? listPm2;
  try {
    const rows = await list({ pm2Bin, pm2Home, transport: deps.transport, io: deps.io });
    return JSON.stringify(rows);
  } catch {
    return null;
  }
}

export async function collectPm2Facts(config, deps = {}) {
  const deployUser = (deps.resolveDeployUser ?? resolveDeployUser)(config.dataRoot);
  const pm2Home = join((deps.userHome ?? userHome)(deployUser), ".pm2");
  const command = deps.commandOutput ?? commandOutput;
  const facts = pm2FactsFrom(
    (deps.readPm2Dump ?? readPm2Dump)(pm2Home),
    await pm2Jlist(pm2Home, deployUser, deps),
  );
  facts.unit = readPm2Unit(deployUser, command);
  return facts;
}

export async function collectFacts(config, deps = {}) {
  const command = deps.commandOutput ?? commandOutput;
  const nginx = command("systemctl", ["is-active", "nginx"]) ?? "unknown";
  const postgresql = command("systemctl", ["is-active", "postgresql"]) ?? "unknown";
  const redis = command("systemctl", ["is-active", "redis-server"]) ?? "unknown";
  const services = { nginx, postgresql, redis };
  const pm2 = await collectPm2Facts(config, deps);
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
  const facts = {
    hostname: command("hostname", []) ?? "",
    loadavg,
    disk: command("df", ["-h", config.dataRoot]) ?? "",
    cpus: cpuCount(),
    memTotalMb: meminfoMbFrom(meminfo, "MemTotal"),
    memAvailableMb: meminfoMbFrom(meminfo, "MemAvailable"),
    collabStatus: command("collab", ["status"]) ?? "collab status unavailable",
    services,
    pm2,
    runtimeStatus: runtimeStatusFrom(services, pm2),
    runtimeVersion:
      command("git", ["-C", config.runtimeDir, "rev-parse", "--short", "HEAD"]) ?? "unknown",
  };
  const boot = (deps.readBootFacts ?? readBootFacts)();
  if (boot) facts.boot = boot;
  return facts;
}

export function buildStatusPayload(config, facts, shutdown) {
  const payload = {
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
    pm2: publicPm2(facts.pm2),
  };
  if (facts.boot && facts.boot.id && Number.isFinite(facts.boot.uptimeSeconds)) {
    payload.boot = { id: facts.boot.id, uptimeSeconds: facts.boot.uptimeSeconds };
  }
  if (shutdown) payload.shutdown = shutdownFields(shutdown);
  return payload;
}

export function buildHeartbeatBody(config, facts, shutdown) {
  return {
    projectId: config.projectId,
    instanceId: config.instanceId,
    token: config.token,
    status: shutdown ? "shutdown_ready" : facts.runtimeStatus,
    runtimeVersion: facts.runtimeVersion,
    agentVersion: config.agentVersion,
    payload: buildStatusPayload(config, facts, shutdown),
  };
}

export function buildStatusBody(config, facts, shutdown) {
  return {
    serverId: config.serverId,
    projectId: config.projectId,
    instanceId: config.instanceId,
    status: facts.runtimeStatus,
    payload: buildStatusPayload(config, facts, shutdown),
  };
}

function publicPm2(pm2) {
  const src = pm2 ?? { dump: "absent", expected: [], processes: [] };
  const out = {
    dump: src.dump ?? "absent",
    expected: Array.isArray(src.expected) ? src.expected : [],
    processes: Array.isArray(src.processes) ? src.processes : [],
  };
  if (src.unit) {
    out.unit = {
      name: src.unit.name ?? "",
      activeState: src.unit.activeState ?? "unknown",
      subState: src.unit.subState ?? "unknown",
      result: src.unit.result ?? "unknown",
      nRestarts: Number.isFinite(src.unit.nRestarts) ? src.unit.nRestarts : null,
    };
  }
  return out;
}

function shutdownFields(shutdown) {
  return {
    requestId: shutdown.requestId,
    stopped: shutdown.stopped.slice(),
    notStopped: shutdown.notStopped.slice(),
    startedAt: shutdown.startedAt,
    finishedAt: shutdown.finishedAt,
  };
}

export function currentBootId(deps = {}) {
  if (typeof deps.bootId === "string") return deps.bootId;
  if (typeof deps.readBootId === "function") return deps.readBootId();
  try {
    return readFileSync(BOOT_ID_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

// Absent, invalid, another boot, or an active cycle without a frozen report
// all project to no payload.shutdown. Invalid is only a fixed diagnostic.
export async function frozenShutdownReport(deps = {}) {
  const read = deps.readShutdownState ?? readShutdownState;
  let state;
  try {
    state = await read({ ...deps, bootId: currentBootId(deps) });
  } catch (err) {
    console.error(`shutdown state unreadable: ${err?.message ?? "unknown"}`);
    return null;
  }
  if (!state || state.status === "absent" || state.status === "other_boot") return null;
  if (state.status === "invalid") {
    console.error(`shutdown state invalid: ${state.reason ?? "malformed"}`);
    return null;
  }
  return shutdownReportSnapshot(state);
}

export function routeStatusRequest({ path, headers, config, facts, shutdown }) {
  if (!requestAllowed(headers ?? {}, config.allowedOrigin)) {
    return { status: 403, body: JSON.stringify({ error: "origin not allowed" }) };
  }
  switch (requestPath(path)) {
    case "/health":
      return { status: 200, body: JSON.stringify({ status: "ok" }) };
    case "/status":
      return { status: 200, body: JSON.stringify(buildStatusBody(config, facts, shutdown)) };
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
  const facts = await (deps.collectFacts ?? collectFacts)(config);
  const shutdown = await frozenShutdownReport(deps);
  const payload = JSON.stringify(buildHeartbeatBody(config, facts, shutdown));
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
  const server = http.createServer(async (req, res) => {
    const facts = await (deps.collectFacts ?? collectFacts)(config);
    const shutdown = await frozenShutdownReport(deps);
    const result = routeStatusRequest({
      path: req.url ?? "/",
      headers: req.headers,
      config,
      facts,
      shutdown,
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
