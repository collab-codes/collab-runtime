// release-notices.mjs — sends the release notices the release scripts left pending (controleReleases, contract v2).
//
// The release scripts (mls-base) never talk to the sites: they write `<releaseId>.aviso-pendente` next to the record
// `<releaseId>.json`. This agent, which holds the sites token, posts each pending code to
// POST /api/v1/servers/<id>/events and removes the code only after the sites answers 2xx. A sites that is down
// leaves the file as it is and the next round tries again (the release itself never fails because of it). The sites
// treats the notice as idempotent by vmId + projetoId + releaseId.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
        details: notice.record,
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
