import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DEFAULT_APPCONFIG,
  accountIdFromRoleArn,
  atomicWriteJson,
  awsErrorCode,
  configure,
  fileOwnerName,
  findAwsSdkDir,
  generateVapidKeys,
  hasAwsSdk,
  loadAwsSdk,
  mergeAppConfig,
  parseConfigureArgs,
  parsePublicConfig,
  parseSecretParameter,
  parseWebPushParameter,
  pm2ProcessUser,
  pm2ReloadSpawn,
  publicKeyFingerprint,
  storageOkFromHealth,
  webPushParamFromStorageParam,
  wrapAssumeRoleError,
  wrapSsmError,
} from "./msg-configure.mjs";

const OLD_APPCONFIG = {
  llm: { openai: "keep-me" },
  hook: { collabtoken: "hand-written" },
  redis: { host: "127.0.0.1", port: 6379 },
  aws: { accessKeyId: "", secretAccessKey: "", bucketName: "legacy-bucket" },
  firebase: { apiKey: "hand-written" },
};

const SECRET = { accessKeyId: "AKIAEXAMPLEPROBE0000", secretAccessKey: "probe-not-a-real-secret" };
const ROLE_ARN = "arn:aws:iam::331191958360:role/collab-messages-param-reader";
const WEBPUSH = {
  publicKey: "vapid-public-example-key",
  privateKey: "vapid-private-example-key",
  subject: "mailto:webpush@collab.codes",
};

function mockAwsSdk({
  assume = { Credentials: { AccessKeyId: "ASIA", SecretAccessKey: "x", SessionToken: "t" } },
  parameter = JSON.stringify(SECRET),
  parameters = null,
  assumeError = null,
  parameterError = null,
} = {}) {
  const stsSends = [];
  const ssmSends = [];
  const ssmPuts = [];
  const ssmConfigs = [];
  class AssumeRoleCommand { constructor(input) { this.input = input; } }
  class GetParameterCommand { constructor(input) { this.input = input; } }
  class PutParameterCommand { constructor(input) { this.input = input; } }
  class STSClient {
    constructor(config) { this.config = config; }
    async send(cmd) {
      stsSends.push(cmd);
      if (assumeError) throw assumeError;
      return assume;
    }
  }
  class SSMClient {
    constructor(config) { ssmConfigs.push(config); this.config = config; }
    async send(cmd) {
      ssmSends.push(cmd);
      if (cmd instanceof PutParameterCommand) {
        ssmPuts.push(cmd);
        return { Version: 1 };
      }
      const name = cmd.input?.Name;
      if (parameters && Object.prototype.hasOwnProperty.call(parameters, name)) {
        const value = parameters[name];
        if (value == null) {
          const missing = new Error("Parameter not found");
          missing.name = "ParameterNotFound";
          throw missing;
        }
        return { Parameter: { Value: value } };
      }
      if (typeof name === "string" && name.endsWith("/webpush") && !parameters) {
        const missing = new Error("Parameter not found");
        missing.name = "ParameterNotFound";
        throw missing;
      }
      if (parameterError) throw parameterError;
      return { Parameter: { Value: parameter } };
    }
  }
  return {
    awsSdk: { STSClient, AssumeRoleCommand, SSMClient, GetParameterCommand, PutParameterCommand },
    stsSends,
    ssmSends,
    ssmPuts,
    ssmConfigs,
  };
}

function writeFakeAwsSdk(nodeModules, { sts = true, ssm = true } = {}) {
  if (sts) {
    const d = join(nodeModules, "@aws-sdk/client-sts");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@aws-sdk/client-sts", main: "index.js", version: "3.0.0" }));
    writeFileSync(join(d, "index.js"), `
      class STSClient { async send() { return { Credentials: { AccessKeyId: "A", SecretAccessKey: "B", SessionToken: "C" } }; } }
      class AssumeRoleCommand { constructor(input) { this.input = input; } }
      module.exports = { STSClient, AssumeRoleCommand };
    `);
  }
  if (ssm) {
    const d = join(nodeModules, "@aws-sdk/client-ssm");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@aws-sdk/client-ssm", main: "index.js", version: "3.0.0" }));
    writeFileSync(join(d, "index.js"), `
      class SSMClient { async send() { return { Parameter: { Value: ${JSON.stringify(JSON.stringify(SECRET))} } }; } }
      class GetParameterCommand { constructor(input) { this.input = input; } }
      class PutParameterCommand { constructor(input) { this.input = input; } }
      module.exports = { SSMClient, GetParameterCommand, PutParameterCommand };
    `);
  }
}

test("parseConfigureArgs requires param and config-json; --role-arn is optional", () => {
  assert.throws(() => parseConfigureArgs([]), /--param is required/);
  assert.throws(
    () => parseConfigureArgs(["--param", "/collab/org/x/msg/aws"]),
    /--config-json is required/,
  );
  const withoutRole = parseConfigureArgs([
    "--param", "/collab/org/aabbccdd/msg/aws",
    "--config-json", '{"instanceId":"i-abc","storage":{"bucket":"collab-msg-aabbccdd"}}',
  ]);
  assert.equal(withoutRole.param, "/collab/org/aabbccdd/msg/aws");
  assert.equal(withoutRole.roleArn, "");
  const parsed = parseConfigureArgs([
    "--param", "/collab/org/aabbccdd/msg/aws",
    "--role-arn", "arn:aws:iam::331191958360:role/collab-messages-param-reader",
    "--config-json", '{"instanceId":"i-abc","storage":{"bucket":"collab-msg-aabbccdd"}}',
  ]);
  assert.equal(parsed.param, "/collab/org/aabbccdd/msg/aws");
  assert.equal(parsed.appconfig, DEFAULT_APPCONFIG);
});

test("parseConfigureArgs never needs the secret on the command line", () => {
  const parsed = parseConfigureArgs([
    "--param", "/collab/org/x/msg/aws",
    "--role-arn", "arn:aws:iam::1:role/collab-messages-param-reader",
    "--config-json", '{"storage":{"dynamoRegion":"us-east-1"}}',
  ]);
  assert.equal(JSON.stringify(parsed).includes("secretAccessKey"), false);
  assert.equal(JSON.stringify(parsed).includes("AKIA"), false);
});

test("mergeAppConfig altera chaves no lugar e preserva o resto", () => {
  const merged = mergeAppConfig(
    OLD_APPCONFIG,
    SECRET,
    { instanceId: "i-host", storage: { dynamoRegion: "us-east-1", s3Region: "us-east-1", bucket: "collab-msg-aabbccdd" } },
  );
  assert.equal(merged.llm.openai, "keep-me");
  assert.equal(merged.hook.collabtoken, "hand-written");
  assert.equal(merged.firebase.apiKey, "hand-written");
  assert.equal(merged.aws.bucketName, "legacy-bucket");
  assert.equal(merged.aws.accessKeyId, SECRET.accessKeyId);
  assert.equal(merged.aws.secretAccessKey, SECRET.secretAccessKey);
  assert.equal(merged.instanceId, "i-host");
  assert.equal(merged.storage.bucket, "collab-msg-aabbccdd");
  assert.equal(merged.storage.dynamoRegion, "us-east-1");
});

test("mergeAppConfig does not drop extra storage keys already present", () => {
  const current = { ...OLD_APPCONFIG, storage: { dynamoRegion: "us-west-1", extra: "keep" } };
  const merged = mergeAppConfig(current, SECRET, { storage: { dynamoRegion: "us-east-1" } });
  assert.equal(merged.storage.dynamoRegion, "us-east-1");
  assert.equal(merged.storage.extra, "keep");
});

test("parseSecretParameter rejects a payload that is not the key pair", () => {
  assert.throws(() => parseSecretParameter("not-json"), /not JSON/);
  assert.throws(() => parseSecretParameter("{}"), /missing accessKeyId/);
  assert.deepEqual(
    parseSecretParameter(JSON.stringify(SECRET)),
    SECRET,
  );
});

test("parsePublicConfig rejects a secret smuggled in as config", () => {
  assert.throws(
    () => parsePublicConfig('{"instanceId":"i-1","aws":{"accessKeyId":"AKIA"}}'),
    /must have key "storage".*unknown key: aws/,
  );
});

test("parsePublicConfig rejects flattened storage keys (cm40 P1)", () => {
  assert.throws(
    () => parsePublicConfig('{"bucket":"collab-msg-x","dynamoRegion":"us-east-1"}'),
    /must have key "storage".*unknown key: bucket, dynamoRegion/,
  );
});

test("storageOkFromHealth reads cm01 storage.ok and surfaces the error code", () => {
  assert.equal(storageOkFromHealth({ storage: { ok: true, accountId: "331191958360" } }).ok, true);
  assert.equal(storageOkFromHealth({ storage: { ok: false, error: "UnrecognizedClientException" } }).error, "UnrecognizedClientException");
  assert.equal(storageOkFromHealth("{not json").error, "health is not JSON");
});

test("configure without --role-arn reads the parameter with instance credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  const mock = mockAwsSdk();
  await configure({
    param: "/collab/org/probe/msg/aws",
    roleArn: "",
    configJson: JSON.stringify({ instanceId: "i-host", storage: { bucket: "collab-msg-aabbccdd" } }),
    appconfig,
    healthUrl: "http://127.0.0.1:8180/health",
  }, {
    awsSdk: mock.awsSdk,
    reloadPm2: async () => {},
    fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(mock.stsSends.length, 0);
  assert.equal(mock.ssmSends.length, 2);
  assert.equal(mock.ssmSends[0].input.Name, "/collab/org/probe/msg/aws");
  assert.equal(mock.ssmSends[0].input.WithDecryption, true);
  assert.equal(mock.ssmSends[1].input.Name, "/collab/org/probe/webpush");
  assert.equal(mock.ssmConfigs[0].credentials, undefined);
});

test("configure writes atomically, reloads, waits health, and never prints the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  chmodSync(appconfig, 0o600);
  const mock = mockAwsSdk();
  const lines = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: ROLE_ARN,
      configJson: JSON.stringify({
        instanceId: "i-host",
        storage: { dynamoRegion: "us-east-1", s3Region: "us-east-1", bucket: "collab-msg-aabbccdd" },
      }),
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true, accountId: "331191958360" } }) }),
      now: () => 0,
      sleep: async () => {},
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const written = JSON.parse(readFileSync(appconfig, "utf8"));
  assert.equal(written.aws.accessKeyId, SECRET.accessKeyId);
  assert.equal(written.aws.secretAccessKey, SECRET.secretAccessKey);
  assert.equal(written.storage.bucket, "collab-msg-aabbccdd");
  assert.equal(written.storage.dynamoRegion, "us-east-1");
  assert.equal(written.hook.collabtoken, "hand-written");
  assert.equal(written.instanceId, "i-host");
  assert.equal(statSync(appconfig).mode & 0o777, 0o600);
  assert.equal(mock.stsSends[0].input.RoleArn, ROLE_ARN);
  assert.equal(mock.stsSends[0].input.RoleSessionName, "collab-msg-configure");
  assert.equal(mock.stsSends[0].input.DurationSeconds, 900);
  assert.equal(mock.ssmSends[0].input.Name, "/collab/org/probe/msg/aws");
  assert.equal(mock.ssmSends[0].input.WithDecryption, true);
  assert.equal(mock.ssmConfigs[0].credentials.accessKeyId, "ASIA");
  const output = lines.join("");
  assert.match(output, /^assume-role\nget-parameter\nget-parameter-webpush\nweb push not configured\nmerge-appconfig\nhook.collabtoken: absent \(secret has no collabtoken\)\nwrite-appconfig\npm2-reload\nwait-health\nok\n$/u);
  assert.equal(output.includes(SECRET.secretAccessKey), false);
  assert.equal(output.includes(SECRET.accessKeyId), false);
  assert.equal(output.includes("ASIA"), false);
});

test("configure exits with the storage error code when /health is not ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  const mock = mockAwsSdk();
  await assert.rejects(
    () => configure({
      param: "/collab/org/x/msg/aws",
      roleArn: "arn:aws:iam::1:role/collab-messages-param-reader",
      configJson: '{"instanceId":"i-1"}',
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: false, error: "AccessDeniedException" } }) }),
      now: () => 0,
      sleep: async () => {},
      healthWaitMs: 0,
      healthPollMs: 0,
    }),
    /AccessDeniedException/,
  );
});

test("atomicWriteJson keeps mode 600 and the previous owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, "{}\n", { mode: 0o600 });
  chmodSync(appconfig, 0o600);
  const before = statSync(appconfig);
  atomicWriteJson(appconfig, { aws: { accessKeyId: "x" } });
  const after = statSync(appconfig);
  assert.equal(after.mode & 0o777, 0o600);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});

test("pm2 reload talks to the appconfig owner, not the installer root", () => {
  const me = userInfo().username;
  const asOther = pm2ReloadSpawn("ubuntu", "msg");
  if (me === "ubuntu") {
    assert.equal(asOther.command, "pm2");
    assert.deepEqual(asOther.args, ["reload", "msg", "--update-env"]);
  } else {
    assert.equal(asOther.command, "sudo");
    assert.deepEqual(asOther.args, ["-u", "ubuntu", "-H", "pm2", "reload", "msg", "--update-env"]);
  }
  const asMe = pm2ReloadSpawn(me, "msg-worker");
  assert.equal(asMe.command, "pm2");
  assert.deepEqual(asMe.args, ["reload", "msg-worker", "--update-env"]);
});

test("pm2ProcessUser reads the owner of the appconfig file", () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, "{}\n");
  assert.equal(fileOwnerName(appconfig), userInfo().username);
  assert.equal(pm2ProcessUser(appconfig), userInfo().username);
});

test("assume-role error names the role and account, never the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  const denied = new Error(`User is not authorized ${SECRET.secretAccessKey} ${SECRET.accessKeyId}`);
  denied.name = "AccessDenied";
  const mock = mockAwsSdk({ assumeError: denied });
  await assert.rejects(
    () => configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: ROLE_ARN,
      configJson: '{"instanceId":"i-1"}',
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
    }),
    (error) => {
      assert.match(error.message, /assume-role failed for arn:aws:iam::331191958360:role\/collab-messages-param-reader/);
      assert.match(error.message, /\(account 331191958360\)/);
      assert.match(error.message, /AccessDenied/);
      assert.equal(error.message.includes(SECRET.secretAccessKey), false);
      assert.equal(error.message.includes(SECRET.accessKeyId), false);
      return true;
    },
  );
  assert.equal(mock.ssmSends.length, 0);
});

test("get-parameter error reports ParameterNotFound, never the value", async () => {
  const missing = new Error(`Parameter ${JSON.stringify(SECRET)} not found`);
  missing.name = "ParameterNotFound";
  const mock = mockAwsSdk({ parameterError: missing });
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  await assert.rejects(
    () => configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: ROLE_ARN,
      configJson: '{"instanceId":"i-1"}',
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
    }),
    (error) => {
      assert.equal(error.message, "get-parameter /collab/org/probe/msg/aws failed: ParameterNotFound");
      assert.equal(error.message.includes(SECRET.secretAccessKey), false);
      return true;
    },
  );
});

test("wrapAssumeRoleError and wrapSsmError only surface the error type", () => {
  assert.equal(accountIdFromRoleArn(ROLE_ARN), "331191958360");
  assert.equal(awsErrorCode({ name: "AccessDenied", message: SECRET.secretAccessKey }), "AccessDenied");
  const wrapped = wrapAssumeRoleError(ROLE_ARN, { name: "AccessDenied", message: SECRET.secretAccessKey });
  assert.equal(wrapped.message.includes(SECRET.secretAccessKey), false);
  assert.match(wrapped.message, /account 331191958360/);
  const ssm = wrapSsmError("/collab/org/x/msg/aws", { name: "AccessDeniedException", message: SECRET.secretAccessKey });
  assert.equal(ssm.message, "get-parameter /collab/org/x/msg/aws failed: AccessDeniedException");
});

test("findAwsSdkDir prefers collab-messages node_modules when both clients exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "aws-sdk-"));
  const msgNm = join(dir, "msg", "node_modules");
  const cliNm = join(dir, "cli", "node_modules");
  writeFakeAwsSdk(msgNm);
  writeFakeAwsSdk(cliNm);
  assert.equal(hasAwsSdk(msgNm), true);
  assert.equal(findAwsSdkDir({ msgNodeModules: msgNm, cliNodeModules: cliNm }), msgNm);
});

test("findAwsSdkDir falls back to the CLI dir when msg is missing client-ssm", () => {
  const dir = mkdtempSync(join(tmpdir(), "aws-sdk-"));
  const msgNm = join(dir, "msg", "node_modules");
  const cliNm = join(dir, "cli", "node_modules");
  writeFakeAwsSdk(msgNm, { ssm: false });
  writeFakeAwsSdk(cliNm);
  assert.equal(hasAwsSdk(msgNm), false);
  assert.equal(findAwsSdkDir({ msgNodeModules: msgNm, cliNodeModules: cliNm }), cliNm);
});

test("findAwsSdkDir tells the operator to install msg, not the AWS CLI", () => {
  const missing = join(tmpdir(), "no-aws-sdk-here");
  assert.throws(
    () => findAwsSdkDir({ candidates: [missing] }),
    /sudo collab msg install/,
  );
  assert.throws(
    () => findAwsSdkDir({ candidates: [missing] }),
    /AWS CLI is not required/,
  );
});

test("loadAwsSdk requires both clients from the given node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "aws-sdk-"));
  const nm = join(dir, "node_modules");
  writeFakeAwsSdk(nm);
  const sdk = loadAwsSdk(nm);
  assert.equal(typeof sdk.STSClient, "function");
  assert.equal(typeof sdk.AssumeRoleCommand, "function");
  assert.equal(typeof sdk.SSMClient, "function");
  assert.equal(typeof sdk.GetParameterCommand, "function");
  assert.equal(typeof sdk.PutParameterCommand, "function");
});

test("loadAwsSdk fails clearly when client-ssm is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "aws-sdk-"));
  const nm = join(dir, "node_modules");
  writeFakeAwsSdk(nm, { ssm: false });
  assert.throws(() => loadAwsSdk(nm), /@aws-sdk\/client-ssm/);
  assert.throws(() => loadAwsSdk(nm), /AWS CLI is not required/);
});

test("msg-configure does not spawn the aws CLI", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "msg-configure.mjs"), "utf8");
  assert.doesNotMatch(src, /spawnSync\(\s*["']aws["']/);
  assert.doesNotMatch(src, /runAws/);
  assert.match(src, /@aws-sdk\/client-sts/);
  assert.match(src, /@aws-sdk\/client-ssm/);
  assert.match(src, /AssumeRoleCommand/);
  assert.match(src, /GetParameterCommand/);
});

test("webPushParamFromStorageParam derives /webpush from the storage param", () => {
  assert.equal(webPushParamFromStorageParam("/collab/org/o1/msg/aws"), "/collab/org/o1/webpush");
  assert.equal(webPushParamFromStorageParam("/elsewhere"), "");
  assert.deepEqual(
    parseWebPushParameter(JSON.stringify(WEBPUSH)),
    WEBPUSH,
  );
  const keys = generateVapidKeys();
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(publicKeyFingerprint(keys.publicKey).length, 16);
});

test("configure with webpush parameter writes webPush at mode 600 (T2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  chmodSync(appconfig, 0o600);
  const before = statSync(appconfig);
  const mock = mockAwsSdk({
    parameters: {
      "/collab/org/probe/msg/aws": JSON.stringify(SECRET),
      "/collab/org/probe/webpush": JSON.stringify(WEBPUSH),
    },
  });
  await configure({
    param: "/collab/org/probe/msg/aws",
    roleArn: "",
    configJson: JSON.stringify({ instanceId: "i-host", storage: { bucket: "collab-msg-probe" } }),
    appconfig,
    healthUrl: "http://127.0.0.1:8180/health",
  }, {
    awsSdk: mock.awsSdk,
    reloadPm2: async () => {},
    fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
    now: () => 0,
    sleep: async () => {},
  });
  const written = JSON.parse(readFileSync(appconfig, "utf8"));
  assert.deepEqual(written.webPush, WEBPUSH);
  assert.equal(written.aws.accessKeyId, SECRET.accessKeyId);
  assert.equal(statSync(appconfig).mode & 0o777, 0o600);
  assert.equal(statSync(appconfig).uid, before.uid);
  assert.equal(mock.ssmSends.some((cmd) => cmd.input?.Name === "/collab/org/probe/webpush"), true);
});

test("configure with flattened --config-json exits != 0 and leaves the file intact (T3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  const original = `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`;
  writeFileSync(appconfig, original);
  const mock = mockAwsSdk();
  await assert.rejects(
    () => configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: "",
      configJson: '{"bucket":"collab-msg-x","dynamoRegion":"us-east-1"}',
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
    }),
    /must have key "storage"/,
  );
  assert.equal(readFileSync(appconfig, "utf8"), original);
  assert.equal(mock.ssmSends.length, 0);
});

test("configure with missing webpush parameter exits 0 without a webPush block (T4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  const mock = mockAwsSdk();
  const lines = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: "",
      configJson: JSON.stringify({ instanceId: "i-host" }),
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
      now: () => 0,
      sleep: async () => {},
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const written = JSON.parse(readFileSync(appconfig, "utf8"));
  assert.equal(written.webPush, undefined);
  assert.match(lines.join(""), /web push not configured/);
});

test("configure with --param outside org format skips webpush with a reason (T8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  const mock = mockAwsSdk({
    parameters: { "/elsewhere": JSON.stringify(SECRET) },
  });
  const lines = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await configure({
      param: "/elsewhere",
      roleArn: "",
      configJson: JSON.stringify({ instanceId: "i-host" }),
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
      now: () => 0,
      sleep: async () => {},
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const skip = "get-parameter-webpush skipped: no webpush param derived from /elsewhere";
  const output = lines.join("");
  assert.equal(
    output,
    `get-parameter\n${skip}\nmerge-appconfig\nhook.collabtoken: absent (secret has no collabtoken)\nwrite-appconfig\npm2-reload\nwait-health\n${skip}\nok\n`,
  );
  const written = JSON.parse(readFileSync(appconfig, "utf8"));
  assert.equal(written.webPush, undefined);
  assert.equal(written.aws.accessKeyId, SECRET.accessKeyId);
  assert.equal(written.instanceId, "i-host");
  assert.equal(mock.ssmSends.length, 1);
  assert.equal(mock.ssmSends[0].input.Name, "/elsewhere");
});

test("11 calls addNewVersion with COLLAB_WEBPUSH_SOURCE=parameter-store (T9)", () => {
  const step11 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "11-install-collab-messages.sh"), "utf8");
  assert.match(
    step11,
    /run_as_deploy env PNPM_BIN=.*COLLAB_WEBPUSH_SOURCE=parameter-store "\$ROOT\/addNewVersion" --updatePackage/,
  );
});

const INSTALLER_APPCONFIG_TOP_KEYS = ["hook", "redis", "aws", "storage", "notificationLog"];

function installerAppconfigTemplate() {
  const step11 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "11-install-collab-messages.sh"), "utf8");
  const match = /cat > "\$NODE_DIR\/appconfig\.json" <<'EOF'\n([\s\S]*?)\nEOF/.exec(step11);
  assert.ok(match, "installer appconfig.json heredoc not found");
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`installer appconfig template is not parseable JSON: ${detail}`);
  }
}

test("installer appconfig template is parseable and has no dead top-level keys (E3)", () => {
  const parsed = installerAppconfigTemplate();
  const keys = Object.keys(parsed);
  const extra = keys.filter((key) => !INSTALLER_APPCONFIG_TOP_KEYS.includes(key));
  assert.equal(
    extra.length,
    0,
    `installer appconfig template has disallowed top-level keys: ${extra.join(", ")}`,
  );
  assert.deepEqual([...keys].sort(), [...INSTALLER_APPCONFIG_TOP_KEYS].sort());
  assert.equal(parsed.hook?.collabtoken, "");
});

const COLLABTOKEN_PROBE = "probe-collabtoken-never-print";

test("mergeAppConfig writes collabtoken from the secret when the current value is empty (T3)", () => {
  const current = { ...OLD_APPCONFIG, hook: { collabtoken: "" } };
  const merged = mergeAppConfig(
    current,
    { ...SECRET, collabtoken: COLLABTOKEN_PROBE },
    { instanceId: "i-host" },
  );
  assert.equal(merged.hook.collabtoken, COLLABTOKEN_PROBE);
  assert.equal(merged.aws.accessKeyId, SECRET.accessKeyId);
});

test("mergeAppConfig preserves a non-empty hook.collabtoken even when the secret has one (T4)", () => {
  const merged = mergeAppConfig(
    OLD_APPCONFIG,
    { ...SECRET, collabtoken: COLLABTOKEN_PROBE },
    { instanceId: "i-host" },
  );
  assert.equal(merged.hook.collabtoken, "hand-written");
});

test("configure declares hook.collabtoken absent when the secret has no collabtoken (T5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  const current = { ...OLD_APPCONFIG, hook: { collabtoken: "" } };
  writeFileSync(appconfig, `${JSON.stringify(current, null, 2)}\n`);
  const mock = mockAwsSdk();
  const lines = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: "",
      configJson: JSON.stringify({ instanceId: "i-host" }),
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
      now: () => 0,
      sleep: async () => {},
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const written = JSON.parse(readFileSync(appconfig, "utf8"));
  assert.equal(written.hook.collabtoken, "");
  const output = lines.join("");
  assert.match(output, /hook\.collabtoken: absent \(secret has no collabtoken\)/);
  assert.equal(output.includes(SECRET.secretAccessKey), false);
});

test("configure never prints the collabtoken (T6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify({ ...OLD_APPCONFIG, hook: { collabtoken: "" } }, null, 2)}\n`);
  const mock = mockAwsSdk({
    parameter: JSON.stringify({ ...SECRET, collabtoken: COLLABTOKEN_PROBE }),
  });
  const lines = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: "",
      configJson: JSON.stringify({ instanceId: "i-host" }),
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      awsSdk: mock.awsSdk,
      reloadPm2: async () => {},
      fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
      now: () => 0,
      sleep: async () => {},
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const written = JSON.parse(readFileSync(appconfig, "utf8"));
  assert.equal(written.hook.collabtoken, COLLABTOKEN_PROBE);
  const output = lines.join("");
  assert.equal(output.includes(COLLABTOKEN_PROBE), false);
  assert.equal(output.includes(SECRET.secretAccessKey), false);
  assert.equal(output.includes(SECRET.accessKeyId), false);
  assert.doesNotMatch(output, /hook\.collabtoken: absent/);
});

test("parseSecretParameter still accepts an old secret without collabtoken (T7)", () => {
  assert.deepEqual(
    parseSecretParameter(JSON.stringify({ ...SECRET, leftover: "ignored" })),
    SECRET,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      parseSecretParameter(JSON.stringify(SECRET)),
      "collabtoken",
    ),
    false,
  );
  assert.deepEqual(
    parseSecretParameter(JSON.stringify({ ...SECRET, collabtoken: COLLABTOKEN_PROBE })),
    { ...SECRET, collabtoken: COLLABTOKEN_PROBE },
  );
});
