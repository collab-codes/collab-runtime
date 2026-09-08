import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_APPCONFIG,
  atomicWriteJson,
  configure,
  fileOwnerName,
  mergeAppConfig,
  parseConfigureArgs,
  parsePublicConfig,
  parseSecretParameter,
  pm2ProcessUser,
  pm2ReloadSpawn,
  storageOkFromHealth,
} from "./msg-configure.mjs";

const OLD_APPCONFIG = {
  llm: { openai: "keep-me" },
  hook: { collabtoken: "hand-written" },
  redis: { host: "127.0.0.1", port: 6379 },
  aws: { accessKeyId: "", secretAccessKey: "", bucketName: "legacy-bucket" },
  firebase: { apiKey: "hand-written" },
};

const SECRET = { accessKeyId: "AKIAEXAMPLEPROBE0000", secretAccessKey: "probe-not-a-real-secret" };

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
  let assumed = false;
  await configure({
    param: "/collab/org/probe/msg/aws",
    roleArn: "",
    configJson: JSON.stringify({ instanceId: "i-host", storage: { bucket: "collab-msg-aabbccdd" } }),
    appconfig,
    healthUrl: "http://127.0.0.1:8180/health",
  }, {
    assumeRole: async () => {
      assumed = true;
      return {};
    },
    getParameter: async (_name, env) => {
      assert.equal(env, undefined);
      return JSON.stringify(SECRET);
    },
    reloadPm2: async () => {},
    fetch: async () => ({ text: async () => JSON.stringify({ storage: { ok: true } }) }),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(assumed, false);
});

test("configure writes atomically, reloads, waits health, and never prints the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  const lines = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await configure({
      param: "/collab/org/probe/msg/aws",
      roleArn: "arn:aws:iam::331191958360:role/collab-messages-param-reader",
      configJson: JSON.stringify({
        instanceId: "i-host",
        storage: { dynamoRegion: "us-east-1", s3Region: "us-east-1", bucket: "collab-msg-aabbccdd" },
      }),
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      assumeRole: async () => ({ AWS_ACCESS_KEY_ID: "ASIA", AWS_SECRET_ACCESS_KEY: "x", AWS_SESSION_TOKEN: "t" }),
      getParameter: async () => JSON.stringify(SECRET),
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
  assert.equal(written.hook.collabtoken, "hand-written");
  assert.equal(written.instanceId, "i-host");
  const output = lines.join("");
  assert.match(output, /^assume-role\nget-parameter\nmerge-appconfig\nwrite-appconfig\npm2-reload\nwait-health\nok\n$/u);
  assert.equal(output.includes(SECRET.secretAccessKey), false);
  assert.equal(output.includes(SECRET.accessKeyId), false);
});

test("configure exits with the storage error code when /health is not ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msg-configure-"));
  const appconfig = join(dir, "appconfig.json");
  writeFileSync(appconfig, `${JSON.stringify(OLD_APPCONFIG, null, 2)}\n`);
  await assert.rejects(
    () => configure({
      param: "/collab/org/x/msg/aws",
      roleArn: "arn:aws:iam::1:role/collab-messages-param-reader",
      configJson: '{"instanceId":"i-1"}',
      appconfig,
      healthUrl: "http://127.0.0.1:8180/health",
    }, {
      assumeRole: async () => ({}),
      getParameter: async () => JSON.stringify(SECRET),
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
