import assert from "node:assert/strict";
import { test } from "node:test";
import { generateVapidKeys, publicKeyFingerprint } from "./msg-configure.mjs";
import {
  parseVapidArgs,
  resolveWebPushParam,
  vapidInit,
  vapidShow,
} from "./msg-vapid.mjs";

const ROLE_ARN = "arn:aws:iam::395971364351:role/OrganizationAccountAccessRole";
const FIRST = {
  publicKey: "first-public-key",
  privateKey: "first-private-secret-key",
  subject: "mailto:webpush@collab.codes",
};
const SECOND = {
  publicKey: "second-public-key",
  privateKey: "second-private-secret-key",
  subject: "mailto:webpush@collab.codes",
};

function mockStore(initial = {}) {
  const store = { ...initial };
  const ssmSends = [];
  class AssumeRoleCommand { constructor(input) { this.input = input; } }
  class GetParameterCommand { constructor(input) { this.input = input; } }
  class PutParameterCommand { constructor(input) { this.input = input; } }
  class STSClient {
    async send(cmd) {
      return {
        Credentials: { AccessKeyId: "ASIA", SecretAccessKey: "x", SessionToken: "t" },
      };
    }
  }
  class SSMClient {
    async send(cmd) {
      ssmSends.push(cmd);
      if (cmd instanceof PutParameterCommand) {
        store[cmd.input.Name] = cmd.input.Value;
        return { Version: 1 };
      }
      const name = cmd.input?.Name;
      if (!Object.prototype.hasOwnProperty.call(store, name)) {
        const missing = new Error("Parameter not found");
        missing.name = "ParameterNotFound";
        throw missing;
      }
      return { Parameter: { Value: store[name] } };
    }
  }
  return {
    awsSdk: { STSClient, AssumeRoleCommand, SSMClient, GetParameterCommand, PutParameterCommand },
    store,
    ssmSends,
  };
}

function captureStdout(fn) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return original.call(process.stdout, chunk, ...rest);
  };
  return (async () => {
    try {
      const result = await fn();
      return { result, output: lines.join("") };
    } finally {
      process.stdout.write = original;
    }
  })();
}

test("parseVapidArgs requires init or show and accepts --project", () => {
  assert.throws(() => parseVapidArgs([]), /usage: collab msg vapid/);
  assert.throws(() => parseVapidArgs(["rotate"]), /unknown vapid command/);
  const parsed = parseVapidArgs(["init", "--project", "o1", "--force"]);
  assert.equal(parsed.command, "init");
  assert.equal(parsed.project, "o1");
  assert.equal(parsed.force, true);
  const show = parseVapidArgs(["show", "--project", "o1"]);
  assert.equal(show.command, "show");
  assert.equal(show.force, false);
});

test("resolveWebPushParam uses --project as orgShortId, same path as configure", () => {
  assert.equal(resolveWebPushParam({ project: "o1", param: "" }), "/collab/org/o1/webpush");
  assert.equal(
    resolveWebPushParam({ project: "", param: "/collab/org/o1/msg/aws" }),
    "/collab/org/o1/webpush",
  );
  assert.equal(
    resolveWebPushParam({ project: "", param: "/collab/org/o1/webpush" }),
    "/collab/org/o1/webpush",
  );
  assert.throws(() => resolveWebPushParam({ project: "", param: "" }), /--project is required/);
});

test("vapid init twice does not replace; --force does (T1)", async () => {
  const mock = mockStore();
  const firstKeys = { ...FIRST };
  const { output: firstOut } = await captureStdout(() => vapidInit({
    command: "init",
    project: "o1",
    param: "",
    roleArn: "",
    force: false,
    subject: FIRST.subject,
  }, { awsSdk: mock.awsSdk, generateKeys: () => firstKeys }));
  assert.match(firstOut, /created web push keys for \/collab\/org\/o1\/webpush/);
  assert.match(firstOut, new RegExp(`publicKey: ${FIRST.publicKey}`));
  assert.equal(firstOut.includes(FIRST.privateKey), false);
  assert.equal(JSON.parse(mock.store["/collab/org/o1/webpush"]).privateKey, FIRST.privateKey);

  const { output: secondOut } = await captureStdout(() => vapidInit({
    command: "init",
    project: "o1",
    param: "",
    roleArn: "",
    force: false,
    subject: FIRST.subject,
  }, { awsSdk: mock.awsSdk, generateKeys: () => SECOND }));
  assert.match(secondOut, /web push keys already exist/);
  assert.equal(secondOut.includes(FIRST.privateKey), false);
  assert.equal(secondOut.includes(SECOND.privateKey), false);
  assert.equal(JSON.parse(mock.store["/collab/org/o1/webpush"]).publicKey, FIRST.publicKey);

  const { output: forceOut } = await captureStdout(() => vapidInit({
    command: "init",
    project: "o1",
    param: "",
    roleArn: ROLE_ARN,
    force: true,
    subject: SECOND.subject,
  }, { awsSdk: mock.awsSdk, generateKeys: () => SECOND }));
  assert.match(forceOut, /every subscription in the organization to be recreated/);
  assert.match(forceOut, new RegExp(`publicKey: ${SECOND.publicKey}`));
  assert.equal(forceOut.includes(SECOND.privateKey), false);
  assert.equal(JSON.parse(mock.store["/collab/org/o1/webpush"]).publicKey, SECOND.publicKey);
  assert.equal(
    mock.ssmSends.some((cmd) => cmd.input?.Type === "SecureString"),
    true,
  );
});

test("vapid show prints the public key and never the private key (T6)", async () => {
  const mock = mockStore({ "/collab/org/o1/webpush": JSON.stringify(FIRST) });
  const { output } = await captureStdout(() => vapidShow({
    command: "show",
    project: "o1",
    param: "",
    roleArn: "",
  }, { awsSdk: mock.awsSdk }));
  assert.match(output, new RegExp(`publicKey: ${FIRST.publicKey}`));
  assert.match(output, new RegExp(`fingerprint: ${publicKeyFingerprint(FIRST.publicKey)}`));
  assert.equal(output.includes(FIRST.privateKey), false);
  assert.equal(output.includes("privateKey"), false);
});

test("generated VAPID keys are P-256 base64url and fingerprint is short", () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(keys.privateKey, "base64url").length, 32);
  assert.equal(publicKeyFingerprint(keys.publicKey).length, 16);
});
