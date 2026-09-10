#!/usr/bin/env node
// collab msg configure — write the org's collab-messages appconfig on the host VM.
//
// Reads the IAM key from Parameter Store with the instance profile (local to
// the org sub-account). --role-arn remains optional for hub VMs that still
// hop via AssumeRole. Merges aws.accessKeyId/secretAccessKey, storage.*
// and instanceId in place; every other key in appconfig.json is left alone.
// The secret is never printed: not to stdout, not to stderr, not in errors.
// AWS calls go through the SDK (no `aws` CLI binary).

import { spawnSync } from "node:child_process";
import { createECDH, createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const allowed = new Set(["storage", "instanceId"]);
  const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`--config-json must have key "storage" (unknown key: ${unknown.join(", ")})`);
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

export function mergeAppConfig(current, secret, publicConfig, webPush) {
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
  if (webPush) {
    next.webPush = {
      publicKey: webPush.publicKey,
      privateKey: webPush.privateKey,
      subject: webPush.subject,
    };
  }
  return next;
}

export const DEFAULT_WEBPUSH_SUBJECT = "mailto:webpush@collab.codes";

export function orgShortIdFromParam(param) {
  const match = /^\/collab\/org\/([^/]+)\//.exec(param || "");
  return match ? match[1] : "";
}

export function webPushParamName(orgShortId) {
  if (!orgShortId) throw new Error("orgShortId is required");
  return `/collab/org/${orgShortId}/webpush`;
}

export function webPushParamFromStorageParam(param) {
  const orgShortId = orgShortIdFromParam(param);
  return orgShortId ? webPushParamName(orgShortId) : "";
}

export function parseWebPushParameter(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("webpush parameter value is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("webpush parameter value is not a JSON object");
  }
  const publicKey = typeof parsed.publicKey === "string" ? parsed.publicKey.trim() : "";
  const privateKey = typeof parsed.privateKey === "string" ? parsed.privateKey.trim() : "";
  const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
  if (!publicKey || !privateKey || !subject) {
    throw new Error("webpush parameter is missing publicKey, privateKey or subject");
  }
  return { publicKey, privateKey, subject };
}

export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey(null, "uncompressed").toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

export function publicKeyFingerprint(publicKey) {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
}

export function atomicWriteJson(path, value) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    throw new Error(`appconfig directory missing: ${dir}`);
  }
  let uid;
  let gid;
  if (existsSync(path)) {
    const st = statSync(path);
    uid = st.uid;
    gid = st.gid;
  }
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  if (uid != null) chownSync(path, uid, gid);
}

export function fileOwnerName(path) {
  if (!path || !existsSync(path)) return "";
  const gnu = spawnSync("stat", ["-c", "%U", path], { encoding: "utf8" });
  if (gnu.status === 0) {
    const name = (gnu.stdout || "").trim();
    if (name) return name;
  }
  const bsd = spawnSync("stat", ["-f", "%Su", path], { encoding: "utf8" });
  if (bsd.status === 0) {
    const name = (bsd.stdout || "").trim();
    if (name) return name;
  }
  return "";
}

export function pm2ProcessUser(appconfigPath) {
  const fromFile = fileOwnerName(appconfigPath);
  if (fromFile) return fromFile;
  const fromData = fileOwnerName("/data");
  if (fromData && fromData !== "root") return fromData;
  return "ubuntu";
}

function currentUserName() {
  const result = spawnSync("id", ["-un"], { encoding: "utf8" });
  return (result.stdout || "").trim();
}

export function pm2ReloadSpawn(user, name) {
  const me = currentUserName();
  if (user && user !== me) {
    return { command: "sudo", args: ["-u", user, "-H", "pm2", "reload", name, "--update-env"] };
  }
  return { command: "pm2", args: ["reload", name, "--update-env"] };
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

export const DEFAULT_MSG_NODE = "/data/msg.collab.codes/node";
export const DEFAULT_CLI_DIR = "/usr/local/lib/collab";

function step(name) {
  process.stdout.write(`${name}\n`);
}

export function awsRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
}

export function awsErrorCode(error) {
  if (!error || typeof error !== "object") return "Error";
  const name = typeof error.name === "string" && error.name && error.name !== "Error" ? error.name : "";
  const code = typeof error.Code === "string" && error.Code
    ? error.Code
    : (typeof error.code === "string" && error.code ? error.code : "");
  return name || code || "Error";
}

export function accountIdFromRoleArn(roleArn) {
  const match = /^arn:aws:iam::(\d+):role\//.exec(roleArn || "");
  return match ? match[1] : "";
}

export function wrapAssumeRoleError(roleArn, error) {
  const code = awsErrorCode(error);
  const account = accountIdFromRoleArn(roleArn);
  const accountPart = account ? ` (account ${account})` : "";
  return new Error(`assume-role failed for ${roleArn}${accountPart}: ${code}`);
}

export function wrapSsmError(name, error) {
  return new Error(`get-parameter ${name} failed: ${awsErrorCode(error)}`);
}

export function wrapSsmPutError(name, error) {
  return new Error(`put-parameter ${name} failed: ${awsErrorCode(error)}`);
}

export function isSsmParameterNotFound(error) {
  if (awsErrorCode(error) === "ParameterNotFound") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ParameterNotFound");
}

export function hasAwsSdk(nodeModulesDir) {
  if (!nodeModulesDir) return false;
  return existsSync(join(nodeModulesDir, "@aws-sdk/client-sts"))
    && existsSync(join(nodeModulesDir, "@aws-sdk/client-ssm"));
}

export function findAwsSdkDir(overrides = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = overrides.candidates ?? [
    overrides.msgNodeModules ?? join(overrides.msgNode ?? DEFAULT_MSG_NODE, "node_modules"),
    overrides.cliNodeModules ?? join(overrides.cliDir ?? DEFAULT_CLI_DIR, "node_modules"),
    join(scriptDir, "node_modules"),
    join(scriptDir, "..", "node_modules"),
  ];
  for (const dir of candidates) {
    if (hasAwsSdk(dir)) return dir;
  }
  throw new Error(
    `AWS SDK not found (need @aws-sdk/client-sts and @aws-sdk/client-ssm). Looked in: ${candidates.join(", ")}. Run: sudo collab msg install. AWS CLI is not required.`,
  );
}

export function loadAwsSdk(nodeModulesDir, requireImpl) {
  const dir = nodeModulesDir ?? findAwsSdkDir();
  const require = requireImpl ?? createRequire(join(dir, "..", "msg-configure-aws.cjs"));
  const load = (pkg) => {
    try {
      return require(pkg);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `cannot load ${pkg} from ${dir}: ${detail}. Run: sudo collab msg install. AWS CLI is not required.`,
      );
    }
  };
  const sts = load("@aws-sdk/client-sts");
  const ssm = load("@aws-sdk/client-ssm");
  if (!sts?.STSClient || !sts?.AssumeRoleCommand || !ssm?.SSMClient || !ssm?.GetParameterCommand || !ssm?.PutParameterCommand) {
    throw new Error(
      `AWS SDK from ${dir} is incomplete. Run: sudo collab msg install. AWS CLI is not required.`,
    );
  }
  return {
    STSClient: sts.STSClient,
    AssumeRoleCommand: sts.AssumeRoleCommand,
    SSMClient: ssm.SSMClient,
    GetParameterCommand: ssm.GetParameterCommand,
    PutParameterCommand: ssm.PutParameterCommand,
  };
}

function ssmClientConfig(env) {
  const config = { region: awsRegion() };
  if (env?.AWS_ACCESS_KEY_ID && env?.AWS_SECRET_ACCESS_KEY && env?.AWS_SESSION_TOKEN) {
    config.credentials = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    };
  }
  return config;
}

export async function assumeRole(roleArn, sdk, deps) {
  const client = deps.stsClient ?? new sdk.STSClient({ region: awsRegion() });
  let parsed;
  try {
    parsed = await client.send(new sdk.AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "collab-msg-configure",
      DurationSeconds: 900,
    }));
  } catch (error) {
    throw wrapAssumeRoleError(roleArn, error);
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

export async function getParameterValue(name, env, sdk, deps) {
  const client = deps.ssmClient ?? new sdk.SSMClient(ssmClientConfig(env));
  let out;
  try {
    out = await client.send(new sdk.GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }));
  } catch (error) {
    throw wrapSsmError(name, error);
  }
  const value = out?.Parameter?.Value;
  if (typeof value !== "string") {
    throw new Error("get-parameter did not return a value");
  }
  return value.replace(/\n$/u, "");
}

export async function getParameterValueOptional(name, env, sdk, deps) {
  try {
    return await getParameterValue(name, env, sdk, deps);
  } catch (error) {
    if (isSsmParameterNotFound(error)) return null;
    throw error;
  }
}

export async function putParameterValue(name, value, env, sdk, deps, overwrite) {
  const client = deps.ssmClient ?? new sdk.SSMClient(ssmClientConfig(env));
  try {
    await client.send(new sdk.PutParameterCommand({
      Name: name,
      Type: "SecureString",
      Overwrite: overwrite === true,
      Value: value,
    }));
  } catch (error) {
    throw wrapSsmPutError(name, error);
  }
}

function reloadPm2(appconfigPath) {
  const user = pm2ProcessUser(appconfigPath);
  for (const name of ["msg", "msg-worker"]) {
    const spawn = pm2ReloadSpawn(user, name);
    const result = spawnSync(spawn.command, spawn.args, { encoding: "utf8" });
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
  const sdk = deps.awsSdk ?? loadAwsSdk(deps.awsSdkDir, deps.require);
  let assumed;
  if (opts.roleArn) {
    step("assume-role");
    assumed = await assumeRole(opts.roleArn, sdk, deps);
  }
  step("get-parameter");
  const raw = await getParameterValue(opts.param, assumed, sdk, deps);
  const secret = parseSecretParameter(raw);
  let webPush;
  const webPushName = webPushParamFromStorageParam(opts.param);
  let webPushSkip;
  if (webPushName) {
    step("get-parameter-webpush");
    const rawPush = await getParameterValueOptional(webPushName, assumed, sdk, deps);
    if (rawPush == null) {
      step("web push not configured");
    } else {
      webPush = parseWebPushParameter(rawPush);
    }
  } else {
    webPushSkip = `get-parameter-webpush skipped: no webpush param derived from ${opts.param}`;
    step(webPushSkip);
  }
  step("merge-appconfig");
  if (!existsSync(opts.appconfig)) {
    throw new Error(`appconfig.json not found: ${opts.appconfig}`);
  }
  const current = JSON.parse(readFileSync(opts.appconfig, "utf8"));
  const merged = mergeAppConfig(current, secret, publicConfig, webPush);
  step("write-appconfig");
  (deps.writeAppconfig ?? atomicWriteJson)(opts.appconfig, merged);
  step("pm2-reload");
  if (deps.reloadPm2) await deps.reloadPm2();
  else reloadPm2(opts.appconfig);
  step("wait-health");
  await waitHealth(opts.healthUrl, deps);
  if (webPushSkip) step(webPushSkip);
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
