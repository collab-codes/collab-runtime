// release-notices.mjs — sends the release notices the release scripts left pending (controleReleases, contract v2).
//
// The release scripts (mls-base) never talk to the sites: they write `<releaseId>.aviso-pendente` next to the record
// `<releaseId>.json`. This agent, which holds the sites token, posts each pending code to
// POST /api/v1/servers/<id>/events and removes the code only after the sites answers 2xx. A sites that is down
// leaves the file as it is and the next round tries again (the release itself never fails because of it). The sites
// treats the notice as idempotent by vmId + projetoId + releaseId.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NOTICE_ORIGIN = "collab-runtime-agent";
export const NOTICE_INTERVAL_MS = 10_000;
const NOTICE_FILE = /^(\d{14})\.aviso-pendente$/u;

/** Folders that can hold release records on this VM: the shared tree, every project tree and the VM queue. */
export function recordDirs(dataRoot = "/data", etcDir = join(dataRoot, "etc")) {
  const dirs = [join(dataRoot, "mls-base", "releases", "registro")];
  try {
    for (const name of readdirSync(dataRoot)) {
      if (/^app\d+$/u.test(name)) dirs.push(join(dataRoot, name, "mls-base", "releases", "registro"));
    }
  } catch { /* no data root yet */ }
  dirs.push(join(etcDir, "releases"));
  return dirs.filter((dir) => existsSync(dir));
}

function readCodes(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.codes) ? parsed.codes.filter((code) => typeof code === "string") : [];
  } catch {
    return [];
  }
}

function writeCodes(file, codes) {
  if (codes.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ codes }, null, 2)}\n`);
  renameSync(tmp, file);
}

export function pendingNotices(dirs) {
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const match = NOTICE_FILE.exec(name);
      if (!match) continue;
      const file = join(dir, name);
      const record = (() => {
        try { return JSON.parse(readFileSync(join(dir, `${match[1]}.json`), "utf8")); } catch { return null; }
      })();
      const codes = readCodes(file);
      if (record && codes.length) found.push({ file, releaseId: match[1], record, codes });
      else if (!record) rmSync(file, { force: true }); // the record is gone (pruned): nothing to tell
    }
  }
  return found;
}

/**
 * One round: send every pending code. Returns `{ sent, failed }` counts. `postJson(url, { headers, body, timeoutMs })`
 * is the agent's own HTTP helper (`{ statusCode }`); an exception or a non-2xx keeps the code for the next round.
 */
export async function sendPendingNotices(config, { postJson, dirs = recordDirs(config.dataRoot), log = console } = {}) {
  const url = `${config.sitesUrl}/api/v1/servers/${config.serverId}/events`;
  let sent = 0;
  let failed = 0;
  for (const notice of pendingNotices(dirs)) {
    let remaining = [...notice.codes];
    for (const code of notice.codes) {
      const payload = JSON.stringify({
        projectId: config.projectId,
        token: config.token,
        level: code === "release.finished" && notice.record.resultado === "falhou" ? "warn" : "info",
        code,
        message: `${code} ${notice.record.fila} ${notice.record.releaseId} ${notice.record.resultado}`,
        // The sites matches record.vmId against the server id of the URL. The release scripts run as the data owner and
        // cannot read the agent env, so the record may carry the hostname; the agent, which knows the server id, says it.
        details: { ...notice.record, vmId: config.serverId },
      });
      try {
        const result = await postJson(url, {
          headers: { "Content-Type": "application/json", "X-Collab-Origin": NOTICE_ORIGIN },
          body: payload,
          timeoutMs: 10_000,
        });
        if (result.statusCode >= 200 && result.statusCode < 300) {
          remaining = remaining.filter((item) => item !== code);
          writeCodes(notice.file, remaining);
          sent += 1;
          continue;
        }
        failed += 1;
        log.error(`release notice ${code} ${notice.releaseId}: sites answered ${result.statusCode}; kept for the next round`);
      } catch (error) {
        failed += 1;
        log.error(`release notice ${code} ${notice.releaseId}: ${error instanceof Error ? error.message : String(error)}; kept for the next round`);
      }
      break; // keep the order: do not send `finished` before `started` was confirmed
    }
  }
  return { sent, failed };
}

// ── A small CLI, to send the pending notices once by hand or against a test receiver (no agent needed) ─────────────
//   node agent/release-notices.mjs --url http://127.0.0.1:5199 --server srv_t --project 102047 --token test [--data-root /data]
function httpPostJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolvePost, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolvePost({ statusCode: res.statusCode ?? 0 }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function flagOf(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export async function cli(argv) {
  const url = flagOf(argv, "--url");
  if (!url) {
    process.stderr.write("usage: release-notices.mjs --url <sites url> --server <id> --project <id> --token <token> [--data-root /data]\n");
    return 2;
  }
  const config = {
    sitesUrl: url.replace(/\/+$/u, ""),
    serverId: flagOf(argv, "--server") ?? "srv_test",
    projectId: flagOf(argv, "--project") ?? "0",
    token: flagOf(argv, "--token") ?? "test",
    dataRoot: flagOf(argv, "--data-root") ?? "/data",
  };
  const result = await sendPendingNotices(config, { postJson: httpPostJson });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.failed > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(await cli(process.argv.slice(2)));
