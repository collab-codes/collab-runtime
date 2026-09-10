import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installSrc = readFileSync(join(root, "install.sh"), "utf8");
const TOKEN = "clone04-secret-token-do-not-leak";

function installHelpers() {
  const start = installSrc.indexOf("json_escape() {");
  const end = installSrc.indexOf("# ── Step 3: Load profile");
  assert.ok(start >= 0 && end > start, "collab_sites helpers not found in install.sh");
  return installSrc.slice(start, end);
}

function listen(status, body) {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}`, received });
    });
  });
}

function leftovers(dir) {
  return readdirSync(dir).filter(
    (name) => !["install-summary.log", "install-detail.log", "sites-events.jsonl"].includes(name),
  );
}

async function runEvent({
  sitesUrl,
  code = "runtime.step_started",
  status = "",
  extra = "",
  details = "{}",
  includeDetails = true,
  call,
}) {
  const dir = mkdtempSync(join(tmpdir(), "clone04-sites-event-"));
  const detailsArg = includeDetails ? ` ${JSON.stringify(details)}` : "";
  const eventCall =
    call ??
    `collab_sites_event "info" ${JSON.stringify(code)} "Starting node" ${JSON.stringify(status)}${detailsArg}`;
  const script = `
set -euo pipefail
export TMPDIR=${JSON.stringify(dir)}
export LOG_DIR=${JSON.stringify(dir)}
export SUMMARY_LOG="\$LOG_DIR/install-summary.log"
export DETAIL_LOG="\$LOG_DIR/install-detail.log"
mkdir -p "\$LOG_DIR"
touch "\$SUMMARY_LOG" "\$DETAIL_LOG"
# shellcheck source=/dev/null
source ${JSON.stringify(join(root, "core/logger.sh"))}
${installHelpers()}
SERVER_ID="srv_clone04"
PROJECT_ID="102057"
SITES_URL=${JSON.stringify(sitesUrl)}
AGENT_TOKEN=${JSON.stringify(TOKEN)}
${extra}
${eventCall}
echo EXIT:$?
`;
  let stdout = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync("bash", ["-c", script], {
      encoding: "utf8",
      timeout: 15_000,
    });
    stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  } catch (err) {
    exitCode = err.status ?? 1;
    stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const jsonlPath = join(dir, "sites-events.jsonl");
  let jsonl = "";
  try {
    jsonl = readFileSync(jsonlPath, "utf8");
  } catch {
    jsonl = "";
  }
  return { dir, stdout, exitCode, jsonl, jsonlPath };
}

test("T1 collab_sites_event logs http=400 and truncated body, exit 0", async () => {
  const longBody = `{"error":"${"x".repeat(250)}"}`;
  const { server, url } = await listen(400, longBody);
  try {
    const { stdout, exitCode, jsonl } = await runEvent({ sitesUrl: url, code: "runtime.step_started" });
    assert.equal(exitCode, 0);
    assert.match(stdout, /EXIT:0/);
    assert.match(stdout, /Failed to report collab-sites event 'runtime\.step_started': http=400 bytes=\d+ body=/);
    assert.match(stdout, /"error":"/);
    assert.ok(!stdout.includes("x".repeat(250)), "body is truncated to 200 chars");
    assert.equal(stdout.includes(TOKEN), false);
    const row = JSON.parse(jsonl.trim().split("\n").at(-1));
    assert.equal(row.ok, false);
    assert.equal(row.http, 400);
    assert.equal(row.code, "runtime.step_started");
  } finally {
    server.close();
  }
});

test("T2 unreachable endpoint logs http=000 and exit 0", async () => {
  const { stdout, exitCode, jsonl } = await runEvent({
    sitesUrl: "http://127.0.0.1:1",
    code: "runtime.ready",
  });
  assert.equal(exitCode, 0);
  assert.match(stdout, /EXIT:0/);
  assert.match(stdout, /Failed to report collab-sites event 'runtime\.ready': http=000 bytes=\d+ body=/);
  assert.equal(stdout.includes(TOKEN), false);
  const row = JSON.parse(jsonl.trim().split("\n").at(-1));
  assert.equal(row.ok, false);
  assert.equal(row.http, 0);
});

test("T3 failed report never prints the agent token", async () => {
  const { server, url } = await listen(400, JSON.stringify({ error: "heartbeat token is invalid", token: TOKEN }));
  try {
    const { stdout, jsonl } = await runEvent({ sitesUrl: url, code: "runtime.bootstrap_started" });
    assert.equal(stdout.includes(TOKEN), false);
    assert.equal(jsonl.includes(TOKEN), false);
  } finally {
    server.close();
  }
});

test("T4 jsonl appends one line per event and survives consecutive writes", async () => {
  const { server, url } = await listen(400, '{"error":"nope"}');
  try {
    const dir = mkdtempSync(join(tmpdir(), "clone04-sites-event-"));
    const script = `
set -euo pipefail
export TMPDIR=${JSON.stringify(dir)}
export LOG_DIR=${JSON.stringify(dir)}
export SUMMARY_LOG="\$LOG_DIR/install-summary.log"
export DETAIL_LOG="\$LOG_DIR/install-detail.log"
mkdir -p "\$LOG_DIR"
touch "\$SUMMARY_LOG" "\$DETAIL_LOG"
source ${JSON.stringify(join(root, "core/logger.sh"))}
${installHelpers()}
SERVER_ID="srv_clone04"
PROJECT_ID="102057"
SITES_URL=${JSON.stringify(url)}
AGENT_TOKEN=${JSON.stringify(TOKEN)}
collab_sites_event "info" "runtime.step_started" "one" "" "{}"
collab_sites_event "error" "runtime.step_failed" "two" "failed" "{}"
echo EXIT:$?
`;
    const { stdout } = await execFileAsync("bash", ["-c", script], { encoding: "utf8", timeout: 15_000 });
    assert.match(stdout, /EXIT:0/);
    const lines = readFileSync(join(dir, "sites-events.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const rows = lines.map((line) => JSON.parse(line));
    assert.equal(rows[0].code, "runtime.step_started");
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].http, 400);
    assert.equal(rows[1].code, "runtime.step_failed");
    assert.equal(rows[1].status, "failed");
    assert.equal(rows[1].ok, false);
    assert.equal(JSON.stringify(rows).includes(TOKEN), false);
    assert.deepEqual(leftovers(dir), []);
  } finally {
    server.close();
  }
});

test("clone08 T1 details {step:x} yields valid JSON payload without extra brace", async () => {
  const { server, url, received } = await listen(200, '{"ok":true}');
  try {
    const { stdout, exitCode, dir } = await runEvent({
      sitesUrl: url,
      details: '{"step":"x"}',
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /EXIT:0/);
    assert.equal(received.length, 1);
    const payload = received[0];
    assert.ok(!payload.endsWith("}}}"), "no leftover } from ${5:-{}}");
    const parsed = JSON.parse(payload);
    assert.deepEqual(parsed.details, { step: "x" });
    assert.equal(stdout.includes(TOKEN), false);
    assert.deepEqual(leftovers(dir), []);
  } finally {
    server.close();
  }
});

test("clone08 T2 omitted 5th argument defaults details to {}", async () => {
  const { server, url, received } = await listen(200, '{"ok":true}');
  try {
    const { stdout, exitCode, dir } = await runEvent({
      sitesUrl: url,
      includeDetails: false,
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /EXIT:0/);
    assert.equal(received.length, 1);
    const parsed = JSON.parse(received[0]);
    assert.deepEqual(parsed.details, {});
    assert.equal(stdout.includes(TOKEN), false);
    assert.deepEqual(leftovers(dir), []);
  } finally {
    server.close();
  }
});

test("clone08 T3 details with quotes and backslashes stay valid JSON", async () => {
  const { server, url, received } = await listen(200, '{"ok":true}');
  try {
    const { stdout, exitCode, dir } = await runEvent({
      sitesUrl: url,
      call: `note=$(json_escape 'say "hi" and path C:\\tmp')
collab_sites_event "info" "runtime.step_started" "Starting node" "" "{\\"note\\":\\"$note\\"}"`,
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /EXIT:0/);
    assert.equal(received.length, 1);
    const parsed = JSON.parse(received[0]);
    assert.equal(parsed.details.note, 'say "hi" and path C:\\tmp');
    assert.equal(stdout.includes(TOKEN), false);
    assert.deepEqual(leftovers(dir), []);
  } finally {
    server.close();
  }
});

test("clone08 T4 invalid payload is logged and not sent, exit 0", async () => {
  const { server, url, received } = await listen(200, '{"ok":true}');
  try {
    const { stdout, exitCode, jsonl, dir } = await runEvent({
      sitesUrl: url,
      details: "{not-json",
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /EXIT:0/);
    assert.match(stdout, /event 'runtime\.step_started': payload inválido localmente \(bytes=\d+\) — não enviado/);
    assert.equal(received.length, 0, "must not send invalid payload");
    assert.equal(stdout.includes(TOKEN), false);
    const row = JSON.parse(jsonl.trim().split("\n").at(-1));
    assert.equal(row.ok, false);
    assert.equal(row.http, 0);
    assert.deepEqual(leftovers(dir), []);
  } finally {
    server.close();
  }
});

test("clone08 T5 failure line includes bytes= with the real payload size", async () => {
  const { server, url, received } = await listen(400, '{"error":"nope"}');
  try {
    const { stdout, exitCode, dir } = await runEvent({
      sitesUrl: url,
      details: '{"step":"x"}',
    });
    assert.equal(exitCode, 0);
    assert.equal(received.length, 1);
    const bytes = Buffer.byteLength(received[0], "utf8");
    assert.match(stdout, new RegExp(`Failed to report collab-sites event 'runtime\\.step_started': http=400 bytes=${bytes} body=`));
    assert.equal(stdout.includes(TOKEN), false);
    assert.deepEqual(leftovers(dir), []);
  } finally {
    server.close();
  }
});

test("clone08 T6 ratchet: install.sh must not contain ${5:-{}}", () => {
  assert.equal(installSrc.includes("${5:-{}}"), false);
});
