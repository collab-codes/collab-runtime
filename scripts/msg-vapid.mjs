#!/usr/bin/env node
// collab msg vapid — generate or show the org VAPID key pair in Parameter Store.
//
// Keys live at /collab/org/<orgShortId>/webpush (SecureString) in the same
// account configure already reads. Region and AssumeRole follow msg-configure.
// The private key is never printed.

import {
  DEFAULT_WEBPUSH_SUBJECT,
  assumeRole,
  generateVapidKeys,
  getParameterValue,
  getParameterValueOptional,
  loadAwsSdk,
  orgShortIdFromParam,
  parseWebPushParameter,
  publicKeyFingerprint,
  putParameterValue,
  webPushParamName,
} from "./msg-configure.mjs";

export function parseVapidArgs(argv) {
  const out = {
    command: "",
    project: "",
    param: "",
    roleArn: "",
    force: false,
    subject: DEFAULT_WEBPUSH_SUBJECT,
  };
  if (argv.length === 0) {
    throw new Error("usage: collab msg vapid init|show [--project <orgShortId>] [--force]");
  }
  out.command = argv[0];
  if (out.command !== "init" && out.command !== "show") {
    throw new Error(`unknown vapid command: ${out.command}`);
  }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    if (arg === "--project") out.project = next();
    else if (arg === "--param") out.param = next();
    else if (arg === "--role-arn") out.roleArn = next();
    else if (arg === "--force") out.force = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (out.command === "show" && out.force) {
    throw new Error("show does not take --force");
  }
  return out;
}

export function resolveWebPushParam(opts) {
  if (opts.param) {
    if (/\/webpush$/u.test(opts.param)) return opts.param;
    const orgShortId = orgShortIdFromParam(opts.param);
    if (orgShortId) return webPushParamName(orgShortId);
    throw new Error(`cannot derive webpush parameter from ${opts.param}`);
  }
  if (opts.project) return webPushParamName(opts.project);
  throw new Error("--project is required");
}

function printPublic(keys) {
  process.stdout.write(`publicKey: ${keys.publicKey}\n`);
  process.stdout.write(`fingerprint: ${publicKeyFingerprint(keys.publicKey)}\n`);
}

function assertNoPrivate(text, privateKey) {
  if (privateKey && text.includes(privateKey)) {
    throw new Error("refusing to print the private key");
  }
}

async function withAws(opts, deps) {
  const sdk = deps.awsSdk ?? loadAwsSdk(deps.awsSdkDir, deps.require);
  let assumed;
  if (opts.roleArn) {
    assumed = await assumeRole(opts.roleArn, sdk, deps);
  }
  return { sdk, assumed };
}

export async function vapidInit(opts, deps = {}) {
  const name = resolveWebPushParam(opts);
  const { sdk, assumed } = await withAws(opts, deps);
  const existingRaw = await getParameterValueOptional(name, assumed, sdk, deps);
  if (existingRaw != null && !opts.force) {
    const existing = parseWebPushParameter(existingRaw);
    const line = `web push keys already exist for ${name}\n`;
    assertNoPrivate(line, existing.privateKey);
    process.stdout.write(line);
    return { created: false, name, keys: existing };
  }
  const generated = (deps.generateKeys ?? generateVapidKeys)();
  const keys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: opts.subject || DEFAULT_WEBPUSH_SUBJECT,
  };
  const value = JSON.stringify(keys);
  await putParameterValue(name, value, assumed, sdk, deps, opts.force === true);
  if (opts.force && existingRaw != null) {
    process.stdout.write(
      "replacing web push keys will require every subscription in the organization to be recreated\n",
    );
  } else {
    process.stdout.write(`created web push keys for ${name}\n`);
  }
  printPublic(keys);
  return { created: true, name, keys };
}

export async function vapidShow(opts, deps = {}) {
  const name = resolveWebPushParam(opts);
  const { sdk, assumed } = await withAws(opts, deps);
  const raw = await getParameterValue(name, assumed, sdk, deps);
  const keys = parseWebPushParameter(raw);
  printPublic(keys);
  return { name, keys };
}

function printError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseVapidArgs(process.argv.slice(2));
    if (args.command === "init") await vapidInit(args);
    else await vapidShow(args);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}
