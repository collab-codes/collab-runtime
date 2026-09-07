#!/usr/bin/env node
// collab msg configure — write the org's collab-messages appconfig on the host VM.
//
// Reads the IAM key from Parameter Store with the instance profile (local to
// the org sub-account). --role-arn remains optional for hub VMs that still
// hop via AssumeRole. Merges aws.accessKeyId/secretAccessKey, storage.*
// and instanceId in place; every other key in appconfig.json is left alone.
// The secret is never printed: not to stdout, not to stderr, not in errors.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_APPCONFIG = "/data/msg.collab.codes/node/appconfig.json";
export const DEFAULT_HEALTH_URL = "http://127.0.0.1:8180/health";
export const HEALTH_WAIT_MS = 30_000;
export const HEALTH_POLL_MS = 2_000;

export function parseConfigureArgs(argv) {
  const out = {
    param: "",
    roleArn: "",
    configJson: "",
    appconfig: DEFAULT_APPCONFIG,
    healthUrl: DEFAULT_HEALTH_URL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    if (arg === "--param") out.param = next();
    else if (arg === "--role-arn") out.roleArn = next();
    else if (arg === "--config-json") out.configJson = next();
    else if (arg === "--appconfig") out.appconfig = next();
    else if (arg === "--health-url") out.healthUrl = next();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!out.param) throw new Error("--param is required");
  if (!out.configJson) throw new Error("--config-json is required");
  return out;
}

export function parseSecretParameter(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("parameter value is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parameter value is not a JSON object");
  }
  const accessKeyId = typeof parsed.accessKeyId === "string" ? parsed.accessKeyId.trim() : "";
  const secretAccessKey = typeof parsed.secretAccessKey === "string" ? parsed.secretAccessKey.trim() : "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("parameter is missing accessKeyId or secretAccessKey");
  }
  return { accessKeyId, secretAccessKey };
}

export function parsePublicConfig(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("--config-json is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--config-json must be a JSON object");
  }
  const next = {};
  if (parsed.storage != null) {
    if (typeof parsed.storage !== "object" || Array.isArray(parsed.storage)) {
      throw new Error("config.storage must be an object");
    }
    next.storage = parsed.storage;
  }
  if (parsed.instanceId !== undefined) {
    if (parsed.instanceId !== null && typeof parsed.instanceId !== "string") {
      throw new Error("config.instanceId must be a string");
    }
    next.instanceId = parsed.instanceId;
  }
  return next;
}

export function mergeAppConfig(current, secret, publicConfig) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("appconfig.json must be a JSON object");
  }
  const next = { ...current };
  const aws = (current.aws && typeof current.aws === "object" && !Array.isArray(current.aws))
    ? { ...current.aws }
    : {};
  aws.accessKeyId = secret.accessKeyId;
  aws.secretAccessKey = secret.secretAccessKey;
  next.aws = aws;
  if (publicConfig.storage) {
    const storage = (current.storage && typeof current.storage === "object" && !Array.isArray(current.storage))
      ? { ...current.storage }
      : {};
    next.storage = { ...storage, ...publicConfig.storage };
  }
  if (Object.prototype.hasOwnProperty.call(publicConfig, "instanceId")) {
    next.instanceId = publicConfig.instanceId;
  }
  return next;
}

export function atomicWriteJson(path, value) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    throw new Error(`appconfig directory missing: ${dir}`);
  }
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function storageOkFromHealth(body) {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, error: "health is not JSON" };
    }
  }
  const storage = parsed && typeof parsed === "object" ? parsed.storage : undefined;
  if (storage && storage.ok === true) return { ok: true };
  const error = (storage && typeof storage.error === "string" && storage.error)
    ? storage.error
    : "storage.ok is not true";
  return { ok: false, error };
}

function step(name) {
  process.stdout.write(`${name}\n`);
}

function runAws(args, env, { hideStdout = false } = {}) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw new Error(`aws ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n")[0];
    throw new Error(`aws ${args[0]} failed: ${err}`);
  }
  return hideStdout ? result.stdout : result.stdout;
}

function assumeRole(roleArn) {
  const raw = runAws([
    "sts", "assume-role",
    "--role-arn", roleArn,
    "--role-session-name", "collab-msg-configure",
    "--duration-seconds", "900",
    "--output", "json",
  ], undefined, { hideStdout: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("assume-role did not return JSON");
  }
  const creds = parsed?.Credentials;
  if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
    throw new Error("assume-role did not return credentials");
  }
  return {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.SessionToken,
  };
}

function getParameterValue(name, env) {
  const value = runAws([
    "ssm", "get-parameter",
    "--name", name,
    "--with-decryption",
    "--query", "Parameter.Value",
    "--output", "text",
  ], env, { hideStdout: true });
  return value.replace(/\n$/u, "");
}

function reloadPm2() {
  for (const name of ["msg", "msg-worker"]) {
    const result = spawnSync("pm2", ["reload", name, "--update-env"], { encoding: "utf8" });
    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n")[0];
      throw new Error(`pm2 reload ${name} failed: ${err}`);
    }
  }
}

async function waitHealth(url, deps) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.healthWaitMs ?? HEALTH_WAIT_MS;
  const pollMs = deps.healthPollMs ?? HEALTH_POLL_MS;
  const deadline = now() + waitMs;
  let lastError = "health did not respond";
  for (;;) {
    try {
      const response = await fetchImpl(url);
      const text = await response.text();
      const health = storageOkFromHealth(text);
      if (health.ok) return;
      lastError = health.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  throw new Error(`health not ready: ${lastError}`);
}

export async function configure(opts, deps = {}) {
  const publicConfig = parsePublicConfig(opts.configJson);
  let assumed;
  if (opts.roleArn) {
    step("assume-role");
    assumed = deps.assumeRole
      ? await deps.assumeRole(opts.roleArn)
      : assumeRole(opts.roleArn);
  }
  step("get-parameter");
  const raw = deps.getParameter
    ? await deps.getParameter(opts.param, assumed)
    : getParameterValue(opts.param, assumed);
  const secret = parseSecretParameter(raw);
  step("merge-appconfig");
  if (!existsSync(opts.appconfig)) {
    throw new Error(`appconfig.json not found: ${opts.appconfig}`);
  }
  const current = JSON.parse(readFileSync(opts.appconfig, "utf8"));
  const merged = mergeAppConfig(current, secret, publicConfig);
  step("write-appconfig");
  (deps.writeAppconfig ?? atomicWriteJson)(opts.appconfig, merged);
  step("pm2-reload");
  if (deps.reloadPm2) await deps.reloadPm2();
  else reloadPm2();
  step("wait-health");
  await waitHealth(opts.healthUrl, deps);
  step("ok");
}

function printError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseConfigureArgs(process.argv.slice(2));
    await configure(args);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}
