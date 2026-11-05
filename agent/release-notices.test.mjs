import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pendingNotices, recordDirs, sendPendingNotices } from "./release-notices.mjs";

const CONFIG = { sitesUrl: "https://sites.example", serverId: "srv_1", projectId: "102047", token: "tok_secret", dataRoot: "/nowhere" };
const quiet = { error() {}, log() {} };

async function withDir(fn) {
  const root = mkdtempSync(join(tmpdir(), "notices-"));
  try {
    const dir = join(root, "app102047", "mls-base", "releases", "registro");
    mkdirSync(dir, { recursive: true });
    return await fn(dir, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function leave(dir, id, codes, record = {}) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ versaoContrato: 2, releaseId: id, fila: "app", projetoId: 102047, resultado: "ok", ...record }));
  writeFileSync(join(dir, `${id}.aviso-pendente`), JSON.stringify({ codes }));
}

test("sends each pending code with the record as details and removes it once the sites confirms", async () => {
  await withDir(async (dir) => {
    leave(dir, "20261105140000", ["release.started", "release.finished"], { vmId: "ip-172-31-26-102" });
    const posted = [];
    const postJson = async (url, { headers, body }) => {
      posted.push({ url, headers, body: JSON.parse(body) });
      return { statusCode: 200 };
    };
    const result = await sendPendingNotices(CONFIG, { postJson, dirs: [dir], log: quiet });
    assert.deepEqual(result, { sent: 2, failed: 0 });
    assert.equal(posted[0].url, "https://sites.example/api/v1/servers/srv_1/events");
    assert.deepEqual(posted.map((p) => p.body.code), ["release.started", "release.finished"]);
    assert.equal(posted[0].body.details.releaseId, "20261105140000");
    assert.equal(posted[0].body.projectId, "102047");
    assert.equal(posted[0].body.details.vmId, "srv_1", "the notice carries the server id the sites expects, not the record hostname");
    assert.equal(posted[0].headers["X-Collab-Origin"], "collab-runtime-agent");
    assert.equal(existsSync(join(dir, "20261105140000.aviso-pendente")), false);
    assert.equal(existsSync(join(dir, "20261105140000.json")), true, "the record stays");
    const again = await sendPendingNotices(CONFIG, { postJson, dirs: [dir], log: quiet });
    assert.deepEqual(again, { sent: 0, failed: 0 });
    assert.equal(posted.length, 2, "a confirmed notice is not sent again");
  });
});

test("a sites that is down keeps the notice and the next round sends it", async () => {
  await withDir(async (dir) => {
    leave(dir, "20261105140000", ["release.finished"]);
    const down = await sendPendingNotices(CONFIG, { postJson: async () => { throw new Error("connect ECONNREFUSED"); }, dirs: [dir], log: quiet });
    assert.deepEqual(down, { sent: 0, failed: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "20261105140000.aviso-pendente"), "utf8")).codes, ["release.finished"]);
    const refused = await sendPendingNotices(CONFIG, { postJson: async () => ({ statusCode: 503 }), dirs: [dir], log: quiet });
    assert.deepEqual(refused, { sent: 0, failed: 1 });
    const back = await sendPendingNotices(CONFIG, { postJson: async () => ({ statusCode: 201 }), dirs: [dir], log: quiet });
    assert.deepEqual(back, { sent: 1, failed: 0 });
    assert.equal(existsSync(join(dir, "20261105140000.aviso-pendente")), false);
  });
});

test("started is confirmed before finished is sent, and only the confirmed code leaves the file", async () => {
  await withDir(async (dir) => {
    leave(dir, "20261105140000", ["release.started", "release.finished"]);
    const codes = [];
    const refuseStarted = async (_url, { body }) => {
      codes.push(JSON.parse(body).code);
      return { statusCode: 503 };
    };
    await sendPendingNotices(CONFIG, { postJson: refuseStarted, dirs: [dir], log: quiet });
    assert.deepEqual(codes, ["release.started"], "finished waits for started");
    let n = 0;
    const startedOnly = async () => ({ statusCode: n++ === 0 ? 200 : 500 });
    await sendPendingNotices(CONFIG, { postJson: startedOnly, dirs: [dir], log: quiet });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "20261105140000.aviso-pendente"), "utf8")).codes, ["release.finished"]);
  });
});

test("a failed release is told as a warning, and a notice whose record was pruned is dropped", async () => {
  await withDir(async (dir) => {
    leave(dir, "20261105140000", ["release.finished"], { resultado: "falhou" });
    writeFileSync(join(dir, "20261105130000.aviso-pendente"), JSON.stringify({ codes: ["release.finished"] }));
    const levels = [];
    await sendPendingNotices(CONFIG, { postJson: async (_u, { body }) => { levels.push(JSON.parse(body).level); return { statusCode: 200 }; }, dirs: [dir], log: quiet });
    assert.deepEqual(levels, ["warn"]);
    assert.equal(existsSync(join(dir, "20261105130000.aviso-pendente")), false, "no record, nothing to tell");
  });
});

test("recordDirs finds the shared tree, every project tree and the VM queue that exist", () => {
  const root = mkdtempSync(join(tmpdir(), "notices-dirs-"));
  try {
    for (const dir of ["mls-base/releases/registro", "app102047/mls-base/releases/registro", "app102056/mls-base/releases/registro", "etc/releases", "other/x"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const found = recordDirs(root, join(root, "etc")).map((dir) => dir.slice(root.length + 1)).sort();
    assert.deepEqual(found, ["app102047/mls-base/releases/registro", "app102056/mls-base/releases/registro", "etc/releases", "mls-base/releases/registro"]);
    assert.deepEqual(pendingNotices([]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
