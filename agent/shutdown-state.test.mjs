import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AWS_WINDOW_MS,
  FAILSAFE_AFTER_MS,
  SELF_BUDGET_MS,
  admitShutdown,
  deriveInstants,
  parseShutdownArgs,
  readShutdownState,
  receiptOf,
  remainingSelfMs,
  shutdownReportSnapshot,
  transitionShutdown,
} from "./shutdown-state.mjs";

const BOOT = "boot-a";
const OTHER = "boot-b";
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const WALL = Date.parse("2026-10-21T02:00:00.000Z");
const MONO = 10_000_000;

function deadlineFromNow(offsetMs = AWS_WINDOW_MS) {
  return new Date(WALL + offsetMs).toISOString();
}

async function fixture() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "rt116-s1-"));
  const deps = { stateDir, bootId: BOOT, now: () => WALL, mono: () => MONO };
  return {
    stateDir,
    deps,
    file: path.join(stateDir, "current.json"),
    async cleanup() {
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test("parse aceita só request-id e deadline UTC", () => {
  const ok = parseShutdownArgs([
    "--deadline",
    "2026-10-21T03:00:00Z",
    "--request-id",
    ID.toUpperCase(),
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.requestId, ID);
  assert.equal(parseShutdownArgs(["--request-id", ID]).reason, "missing_arg");
  assert.equal(parseShutdownArgs(["--request-id", "nope", "--deadline", "2026-10-21T03:00:00Z"]).reason, "bad_uuid");
  assert.equal(parseShutdownArgs(["--request-id", ID, "--deadline", "2026-10-21T03:00:00-03:00"]).reason, "bad_deadline");
  assert.equal(parseShutdownArgs(["--request-id", ID, "--deadline", "2026-10-21T03:00:00Z", "--shell"]).reason, "unknown_arg");
});

test("pedido vencido ou requestedAt além de 60s não grava", async () => {
  const fx = await fixture();
  try {
    const expired = await admitShutdown(
      { requestId: ID, deadline: new Date(WALL).toISOString() },
      fx.deps,
    );
    assert.equal(expired.result, "rejected");
    assert.equal(expired.reason, "expired");
    const future = await admitShutdown(
      { requestId: ID, deadline: new Date(WALL + AWS_WINDOW_MS + 60_001).toISOString() },
      fx.deps,
    );
    assert.equal(future.reason, "future");
    await assert.rejects(readFile(fx.file, "utf8"));
    assert.equal(receiptOf(expired).result, "rejected");
    assert.equal("accepted" in receiptOf(future), false);
  } finally {
    await fx.cleanup();
  }
});

test("admissão grava um registro e o mesmo id devolve o mesmo prazo", async () => {
  const fx = await fixture();
  try {
    const deadline = deadlineFromNow();
    const first = await admitShutdown({ requestId: ID, deadline }, fx.deps);
    assert.equal(first.result, "durable");
    assert.equal(first.record.seq, 1);
    assert.equal(first.record.phase, "requested");
    assert.equal(first.record.bootId, BOOT);
    const times = deriveInstants(Date.parse(deadline));
    assert.equal(first.record.requestedAt, times.requestedAt);
    assert.equal(first.record.selfDeadlineAt, times.selfDeadlineAt);
    assert.equal(Date.parse(times.failsafeAt) - Date.parse(times.requestedAt), FAILSAFE_AFTER_MS);
    assert.equal(Date.parse(times.selfDeadlineAt) - Date.parse(times.requestedAt), SELF_BUDGET_MS);
    const mode = await stat(fx.file);
    const dirMode = await stat(fx.stateDir);
    assert.equal(mode.mode & 0o777, 0o600);
    assert.equal(dirMode.mode & 0o777, 0o700);
    const again = await admitShutdown(
      { requestId: ID, deadline: deadline.replace(".000Z", "Z") },
      { ...fx.deps, now: () => WALL + 30 * 60 * 1000, mono: () => MONO + 999 },
    );
    assert.equal(again.result, "existing");
    assert.equal(again.record.seq, 1);
    assert.equal(again.record.selfDeadlineAt, first.record.selfDeadlineAt);
    assert.equal(again.record.monoAtAdmit, MONO);
    const names = await readdir(fx.stateDir);
    assert.deepEqual(names, ["current.json"]);
  } finally {
    await fx.cleanup();
  }
});

test("deadline diferente é conflict e outro id no mesmo boot é busy até depois da fase final", async () => {
  const fx = await fixture();
  try {
    const deadline = deadlineFromNow();
    await admitShutdown({ requestId: ID, deadline }, fx.deps);
    const before = await readFile(fx.file, "utf8");
    const conflict = await admitShutdown(
      { requestId: ID, deadline: deadlineFromNow(AWS_WINDOW_MS + 5000) },
      fx.deps,
    );
    assert.equal(conflict.result, "conflict");
    assert.equal(conflict.activeRequestId, ID);
    const busy = await admitShutdown({ requestId: ID2, deadline }, fx.deps);
    assert.equal(busy.result, "busy");
    assert.equal(busy.activeRequestId, ID);
    const report = {
      stopped: ["nginx"],
      notStopped: ["postgresql@14-main.service"],
      startedAt: new Date(WALL).toISOString(),
      finishedAt: new Date(WALL + 1000).toISOString(),
    };
    const done = await transitionShutdown({ phase: "services_stopped", report }, fx.deps);
    assert.equal(done.record.seq, 2);
    const stillBusy = await admitShutdown({ requestId: ID2, deadline }, fx.deps);
    assert.equal(stillBusy.result, "busy");
    const raw = JSON.parse(await readFile(fx.file, "utf8"));
    assert.equal(raw.requestId, ID);
    assert.equal(raw.seq, 2);
    assert.equal(before.includes(ID2), false);
  } finally {
    await fx.cleanup();
  }
});

test("outro boot não reexecuta o id antigo e aceita id novo", async () => {
  const fx = await fixture();
  try {
    const deadline = deadlineFromNow();
    await admitShutdown({ requestId: ID, deadline }, fx.deps);
    const stale = await admitShutdown({ requestId: ID, deadline }, { ...fx.deps, bootId: OTHER });
    assert.equal(stale.result, "stale_boot");
    const untouched = JSON.parse(await readFile(fx.file, "utf8"));
    assert.equal(untouched.bootId, BOOT);
    const seen = await readShutdownState({ ...fx.deps, bootId: OTHER });
    assert.equal(seen.status, "other_boot");
    assert.equal(shutdownReportSnapshot(seen), null);
    const freshDeadline = deadlineFromNow(AWS_WINDOW_MS);
    const fresh = await admitShutdown(
      { requestId: ID2, deadline: freshDeadline },
      { ...fx.deps, bootId: OTHER },
    );
    assert.equal(fresh.result, "durable");
    assert.equal(fresh.record.bootId, OTHER);
    assert.equal(fresh.record.seq, 1);
    assert.equal(fresh.record.requestId, ID2);
  } finally {
    await fx.cleanup();
  }
});

test("json truncado permanece inválido e não vira estado vazio", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.file, '{"v":1,"requestId":', { mode: 0o600 });
    const read = await readShutdownState(fx.deps);
    assert.equal(read.status, "invalid");
    const admit = await admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, fx.deps);
    assert.equal(admit.result, "invalid_state");
    assert.equal(await readFile(fx.file, "utf8"), '{"v":1,"requestId":');
    const move = await transitionShutdown({ phase: "stopping" }, fx.deps);
    assert.equal(move.result, "invalid_state");
  } finally {
    await fx.cleanup();
  }
});

test("crash antes do rename não publica arquivo parcial; o retry grava um pedido", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, { ...fx.deps, crash: "before-rename" }),
      /crash-before-rename/,
    );
    await assert.rejects(stat(fx.file));
    const leftover = (await readdir(fx.stateDir)).filter((name) => name !== "current.json");
    assert.deepEqual(leftover, []);
    const retry = await admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, fx.deps);
    assert.equal(retry.result, "durable");
    assert.equal(retry.record.seq, 1);
    JSON.parse(await readFile(fx.file, "utf8"));
  } finally {
    await fx.cleanup();
  }
});

test("crash depois do rename conserva o json inteiro e o retry não abre outro pedido", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, { ...fx.deps, crash: "after-rename" }),
      /crash-after-rename/,
    );
    const raw = await readFile(fx.file, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.requestId, ID);
    assert.equal(parsed.seq, 1);
    const retry = await admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, fx.deps);
    assert.equal(retry.result, "existing");
    assert.equal(retry.record.seq, 1);
    assert.equal(retry.record.selfDeadlineAt, parsed.selfDeadlineAt);
  } finally {
    await fx.cleanup();
  }
});

test("salto do relógio não aumenta o prazo nem a seq", async () => {
  const fx = await fixture();
  try {
    const admitted = await admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, fx.deps);
    const jumpedWall = WALL + 40 * 60 * 1000;
    const monoLater = MONO + 60_000;
    const left = remainingSelfMs(admitted.record, monoLater);
    assert.equal(left, SELF_BUDGET_MS - 60_000);
    const again = await admitShutdown(
      { requestId: ID, deadline: deadlineFromNow() },
      { ...fx.deps, now: () => jumpedWall, mono: () => monoLater },
    );
    assert.equal(again.record.deadline, admitted.record.deadline);
    assert.equal(again.record.selfDeadlineAt, admitted.record.selfDeadlineAt);
    assert.equal(again.record.seq, 1);
    assert.equal(remainingSelfMs(again.record, monoLater), left);
  } finally {
    await fx.cleanup();
  }
});

test("leitura durante a troca vê só json completo e a seq não regride", async () => {
  const fx = await fixture();
  try {
    await admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, fx.deps);
    const seen = [];
    const realOpen = (await import("node:fs/promises")).open;
    const fs = {
      async open(file, flags, mode) {
        const fh = await realOpen(file, flags, mode);
        if (String(file).endsWith("current.json") && flags === "r") {
          const text = await readFile(file, "utf8");
          JSON.parse(text);
          seen.push(JSON.parse(text).seq);
        }
        return fh;
      },
    };
    const moved = await transitionShutdown(
      { phase: "stopping" },
      { ...fx.deps, fs },
    );
    assert.equal(moved.record.seq, 2);
    const after = await readShutdownState({ ...fx.deps, fs });
    assert.equal(after.status, "active");
    assert.equal(after.record.seq, 2);
    assert.ok(seen.every((seq) => seq === 1 || seq === 2));
    assert.ok(seen.includes(2));
    const back = await transitionShutdown({ phase: "requested" }, fx.deps);
    assert.equal(back.record.seq, 3);
    assert.equal(back.record.requestId, ID);
    assert.equal(back.record.deadline, moved.record.deadline);
    assert.ok(back.record.seq > moved.record.seq);
  } finally {
    await fx.cleanup();
  }
});

test("snapshot do heartbeat só sai do relatório congelado do boot corrente", async () => {
  const fx = await fixture();
  try {
    await admitShutdown({ requestId: ID, deadline: deadlineFromNow() }, fx.deps);
    assert.equal(shutdownReportSnapshot(await readShutdownState(fx.deps)), null);
    const report = {
      stopped: [],
      notStopped: ["redis-server"],
      startedAt: "2026-10-21T02:00:01.000Z",
      finishedAt: "2026-10-21T02:10:00.000Z",
    };
    await transitionShutdown({ phase: "deadline_exceeded", report }, fx.deps);
    const snap = shutdownReportSnapshot(await readShutdownState(fx.deps));
    assert.deepEqual(Object.keys(snap).sort(), ["finishedAt", "notStopped", "requestId", "startedAt", "stopped"]);
    assert.deepEqual(snap.notStopped, ["redis-server"]);
    const changed = await transitionShutdown(
      {
        phase: "deadline_exceeded",
        report: { ...report, finishedAt: "2026-10-21T02:40:00.000Z", notStopped: [] },
      },
      fx.deps,
    );
    assert.equal(changed.result, "rejected");
    assert.equal(changed.reason, "report_frozen");
    const still = shutdownReportSnapshot(await readShutdownState(fx.deps));
    assert.equal(still.finishedAt, report.finishedAt);
    assert.deepEqual(still.notStopped, ["redis-server"]);
    const other = await readShutdownState({ ...fx.deps, bootId: OTHER });
    assert.equal(shutdownReportSnapshot(other), null);
  } finally {
    await fx.cleanup();
  }
});

test("registro com token ou stdout é inválido e não é regravado", async () => {
  const fx = await fixture();
  try {
    const body = {
      v: 1,
      requestId: ID,
      deadline: deadlineFromNow(),
      requestedAt: new Date(WALL).toISOString(),
      selfDeadlineAt: new Date(WALL + SELF_BUDGET_MS).toISOString(),
      bootId: BOOT,
      phase: "requested",
      seq: 1,
      poweroffRequestedAt: null,
      report: null,
      monoAtAdmit: MONO,
      wallAtAdmit: WALL,
      token: "secret",
      stdout: "dump",
    };
    await writeFile(fx.file, JSON.stringify(body), { mode: 0o600 });
    const read = await readShutdownState(fx.deps);
    assert.equal(read.status, "invalid");
    assert.equal(JSON.stringify(read).includes("secret"), false);
    const admit = await admitShutdown({ requestId: ID2, deadline: deadlineFromNow() }, fx.deps);
    assert.equal(admit.result, "invalid_state");
    assert.equal((await readFile(fx.file, "utf8")).includes("secret"), true);
  } finally {
    await fx.cleanup();
  }
});
