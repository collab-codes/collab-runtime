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
  hasAwsSdk,
  loadAwsSdk,
  mergeAppConfig,
  parseConfigureArgs,
  parsePublicConfig,
  parseSecretParameter,
  pm2ProcessUser,
  pm2ReloadSpawn,
  storageOkFromHealth,
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

function mockAwsSdk({
  assume = { Credentials: { AccessKeyId: "ASIA", SecretAccessKey: "x", SessionToken: "t" } },
  parameter = JSON.stringify(SECRET),
  assumeError = null,
  parameterError = null,
} = {}) {
  const stsSends = [];
  const ssmSends = [];
  const ssmConfigs = [];
  class AssumeRoleCommand { constructor(input) { this.input = input; } }
  class GetParameterCommand { constructor(input) { this.input = input; } }
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
      if (parameterError) throw parameterError;
      return { Parameter: { Value: parameter } };
    }
  }
  return {
    awsSdk: { STSClient, AssumeRoleCommand, SSMClient, GetParameterCommand },
    stsSends,
    ssmSends,
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
      module.exports = { SSMClient, GetParameterCommand };
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
  const parsed = parsePublicConfig('{"instanceId":"i-1","aws":{"accessKeyId":"AKIA"}}');
  assert.equal(parsed.aws, undefined);
  assert.equal(parsed.instanceId, "i-1");
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
  assert.equal(mock.ssmSends.length, 1);
  assert.equal(mock.ssmSends[0].input.Name, "/collab/org/probe/msg/aws");
  assert.equal(mock.ssmSends[0].input.WithDecryption, true);
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
  assert.match(output, /^assume-role\nget-parameter\nmerge-appconfig\nwrite-appconfig\npm2-reload\nwait-health\nok\n$/u);
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
