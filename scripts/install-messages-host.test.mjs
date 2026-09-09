import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const install = readFileSync(join(root, "install.sh"), "utf8");
const cli = readFileSync(join(root, "collab"), "utf8");

test("install.sh defaults to skipping collab-messages and logs the skip", () => {
  assert.match(install, /MESSAGES_HOST=false/);
  assert.match(install, /--messages-host\)/);
  assert.match(install, /skipped: not the messages host/);
  assert.match(install, /run_step 11 "collab-messages"/);
});

test("collab CLI exposes msg install and msg configure", () => {
  assert.match(cli, /install\|update\)/);
  assert.match(cli, /configure\)/);
  assert.match(cli, /msg-configure\.mjs/);
});

test("collab CLI exposes msg vapid and install.sh copies the script", () => {
  assert.match(cli, /vapid\)/);
  assert.match(cli, /msg-vapid\.mjs/);
  assert.match(cli, /vapid init\|show/);
  assert.match(install, /msg-vapid\.mjs/);
});

test("install.sh never installs the AWS CLI", () => {
  assert.doesNotMatch(install, /aws-cli|awscli|snap install aws/);
  assert.match(install, /run_step 11 "collab-messages"/);
});
