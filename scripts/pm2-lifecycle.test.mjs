import assert from "node:assert/strict";
import test from "node:test";
import {
  controlChain,
  ownDescendants,
  environMatchesHome,
  guardPm2,
  observeTarget,
  pidsFromJlist,
  procIdentity,
  startTimeFromStat,
  stopPm2,
  verifyPostStop,
} from "./pm2-lifecycle.mjs";

const BOOT = "boot-a";
const HOME = "/home/deploy";
const PM2_HOME = "/home/deploy/.pm2";
const UNIT = "/sys/fs/cgroup/system.slice/pm2-deploy.service";
const CALLER = "/sys/fs/cgroup/system.slice/other.service";
const SECRET = "token-secret-do-not-log";

function statLine(pid, comm, startTime) {
  return `${pid} (${comm}) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime}\n`;
}

function status(uid) {
  return `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
}

function environ(home = HOME) {
  return `HOME=${home}\0PM2_HOME=${home}/.pm2\0COLLAB_TOKEN=${SECRET}\0`;
}

function world(overrides = {}) {
  const procs = new Map();
  const files = new Map();
  const logs = [];
  const cgroupReads = [];
  const jlistCalls = [];
  let now = 0;
  let rpc = true;
  let killCalls = 0;
  /** @type {((code: number) => void)|null} */
  let finishKill = null;
  /** @type {number|null} */
  let killCode = null;
  const cgroup = new Set([1, 10, 11]);

  const put = (pid, startTime, uid = 1000) => {
    procs.set(pid, {
      stat: statLine(pid, "app", startTime),
      status: status(uid),
      environ: environ(),
    });
  };
  put(1, 50);
  put(10, 1000);
  put(11, 2000);

  files.set(`${PM2_HOME}/pm2.pid`, "10\n");

  const io = {
    now() {
      return now;
    },
    async sleep(ms) {
      now += ms;
      if (finishKill && killCode === null) {
        killCode = 0;
        finishKill(0);
      }
    },
    log(line) {
      logs.push(line);
    },
    readFile(file) {
      if (file === "/proc/sys/kernel/random/boot_id") {
        return `${BOOT}\n`;
      }
      if (files.has(file)) {
        return files.get(file);
      }
      const proc = /^\/proc\/(\d+)\/(stat|status|environ)$/.exec(file);
      if (proc) {
        const row = procs.get(Number(proc[1]));
        if (!row) {
          const error = new Error("gone");
          error.code = "ENOENT";
          throw error;
        }
        return row[proc[2]];
      }
      const error = new Error(`missing ${file}`);
      error.code = "ENOENT";
      throw error;
    },
    exists(file) {
      if (file === `${PM2_HOME}/rpc.sock`) {
        return rpc;
      }
      if (file === UNIT) {
        return true;
      }
      return files.has(file);
    },
    writeAtomic(file, text, mode) {
      assert.equal(mode, 0o600);
      files.set(file, text);
    },
    listCgroupPids(root) {
      cgroupReads.push(root);
      if (root !== UNIT) {
        return [99];
      }
      return [...cgroup];
    },
    jlist() {
      jlistCalls.push(rpc);
      if (!rpc) {
        throw new Error("jlist after rpc loss");
      }
      return [11];
    },
    spawnKill() {
      killCalls += 1;
      const finished = new Promise((resolve) => {
        finishKill = resolve;
      });
      return { pid: 50, finished };
    },
  };

  return {
    io,
    procs,
    files,
    logs,
    cgroup,
    cgroupReads,
    jlistCalls,
    get now() {
      return now;
    },
    set rpc(value) {
      rpc = value;
    },
    get rpc() {
      return rpc;
    },
    get killCalls() {
      return killCalls;
    },
    finish(code) {
      killCode = code;
      finishKill?.(code);
    },
    receipt() {
      const raw = files.get(`${PM2_HOME}/collab-stop.json`);
      return raw ? JSON.parse(raw) : null;
    },
    ...overrides,
  };
}

function base(io, extra = {}) {
  return {
    io,
    pm2Bin: "/usr/bin/pm2",
    pm2Home: PM2_HOME,
    unitCgroup: UNIT,
    uid: 1000,
    home: HOME,
    helperPid: 1,
    deadlineMs: 200,
    pollMs: 10,
    ...extra,
  };
}

test("starttime is field 22, not a file mtime, when comm has parentheses", () => {
  const startTime = startTimeFromStat(statLine(12, "node (worker)", 999888));
  assert.equal(startTime, 999888);
  assert.equal(environMatchesHome(`HOME=${HOME}\0PM2_HOME=${PM2_HOME}\0`, PM2_HOME, HOME), true);
  assert.equal(environMatchesHome(`HOME=/tmp\0PM2_HOME=/tmp/.pm2\0`, PM2_HOME, HOME), false);
});

test("cli exit 0 with a slow child does not authorize the next start", async () => {
  const box = world();
  let sleeps = 0;
  const inner = box.io.sleep.bind(box.io);
  box.io.sleep = async (ms) => {
    sleeps += 1;
    if (sleeps === 1) {
      box.finish(0);
      await inner(ms);
      assert.equal(box.receipt().confirmed, false);
      return;
    }
    if (sleeps === 2) {
      box.procs.delete(10);
      box.procs.delete(11);
      box.files.delete(`${PM2_HOME}/pm2.pid`);
      box.cgroup.clear();
      box.cgroup.add(1);
      box.cgroup.add(12);
      box.procs.set(12, {
        stat: statLine(12, "app", 3000),
        status: status(1000),
        environ: environ(),
      });
    }
    if (sleeps === 3) {
      box.cgroup.delete(12);
      box.procs.delete(12);
    }
    await inner(ms);
  };
  assert.equal(await stopPm2(base(box.io)), 0);
  assert.equal(box.killCalls, 1);
  assert.equal(box.receipt().confirmed, true);
  assert.equal(box.logs.join("\n").includes(SECRET), false);
  const guardWhileAlive = world();
  guardWhileAlive.files.set(`${PM2_HOME}/collab-stop.json`, JSON.stringify({
    bootId: BOOT,
    phase: "stopping",
    confirmed: false,
    identities: [procIdentity(BOOT, 11, 2000)],
  }));
  assert.equal(await guardPm2(base(guardWhileAlive.io)), 1);
  assert.equal(guardWhileAlive.jlistCalls.length, 0);
  assert.equal(guardWhileAlive.killCalls, 0);
  assert.equal(await guardPm2(base(box.io)), 0);
});

test("daemon exit leaves a live child, and a vanished socket is not success", async () => {
  const box = world();
  let sleeps = 0;
  const inner = box.io.sleep.bind(box.io);
  box.io.sleep = async (ms) => {
    sleeps += 1;
    if (sleeps === 1) {
      box.finish(0);
      box.procs.delete(10);
      box.files.delete(`${PM2_HOME}/pm2.pid`);
      box.cgroup.delete(10);
      box.rpc = false;
      await inner(ms);
      assert.equal(box.receipt().confirmed, false);
      return;
    }
    if (sleeps === 2) {
      box.procs.delete(11);
      box.cgroup.delete(11);
    }
    await inner(ms);
  };
  assert.equal(await stopPm2(base(box.io)), 0);
  assert.equal(box.jlistCalls.some((open) => open === false), false);
  assert.equal(box.receipt().phase, "stopped");
  assert.equal(box.receipt().confirmed, true);
});

test("cli error, timeout, permission, and uid mismatch stay unconfirmed", async () => {
  const cli = world();
  const inner = cli.io.sleep.bind(cli.io);
  cli.io.sleep = async (ms) => {
    cli.finish(2);
    await inner(ms);
  };
  assert.equal(await stopPm2(base(cli.io)), 1);
  assert.equal(cli.receipt().phase, "stopping");
  assert.equal(cli.receipt().confirmed, false);

  const slow = world();
  assert.equal(await stopPm2(base(slow.io, { deadlineMs: 25, pollMs: 20 })), 1);
  assert.ok(slow.now <= 25);
  assert.equal(slow.receipt().confirmed, false);
  assert.equal(slow.receipt().phase, "stopping");

  const denied = world();
  denied.io.listCgroupPids = () => {
    const error = new Error("no");
    error.code = "EACCES";
    throw error;
  };
  assert.equal(await stopPm2(base(denied.io)), 1);
  assert.equal(denied.killCalls, 0);
  assert.equal(await guardPm2(base(denied.io)), 1);

  const mismatch = world();
  mismatch.procs.get(10).status = status(0);
  assert.equal(await stopPm2(base(mismatch.io)), 1);
  assert.equal(mismatch.killCalls, 0);
  assert.equal(mismatch.receipt() === null || mismatch.receipt().confirmed === false, true);
});

test("reused pid and a receipt from another boot are not the old process", async () => {
  const reused = world();
  reused.procs.delete(10);
  reused.files.delete(`${PM2_HOME}/pm2.pid`);
  reused.cgroup.clear();
  reused.cgroup.add(1);
  reused.procs.set(11, {
    stat: statLine(11, "other", 8888),
    status: status(1000),
    environ: environ(),
  });
  reused.files.set(`${PM2_HOME}/collab-stop.json`, JSON.stringify({
    bootId: BOOT,
    phase: "stopping",
    confirmed: false,
    identities: [procIdentity(BOOT, 11, 2000)],
  }));
  assert.equal(await guardPm2(base(reused.io)), 0);
  assert.equal(reused.receipt().confirmed, true);

  const daemon = world();
  daemon.procs.set(11, {
    stat: statLine(11, "pm2", 8888),
    status: status(1000),
    environ: environ(),
  });
  daemon.files.set(`${PM2_HOME}/pm2.pid`, "11\n");
  daemon.cgroup.clear();
  daemon.cgroup.add(1);
  daemon.cgroup.add(11);
  daemon.files.set(`${PM2_HOME}/collab-stop.json`, JSON.stringify({
    bootId: BOOT,
    phase: "stopped",
    confirmed: true,
    identities: [procIdentity(BOOT, 11, 2000)],
  }));
  assert.equal(await guardPm2(base(daemon.io)), 1);

  const otherBoot = world();
  otherBoot.procs.clear();
  otherBoot.files.delete(`${PM2_HOME}/pm2.pid`);
  otherBoot.cgroup.clear();
  otherBoot.cgroup.add(1);
  otherBoot.files.set(`${PM2_HOME}/collab-stop.json`, JSON.stringify({
    bootId: "boot-old",
    phase: "stopping",
    confirmed: false,
    identities: [procIdentity("boot-old", 11, 2000)],
  }));
  assert.equal(await guardPm2(base(otherBoot.io)), 0);

  const unlinked = world();
  assert.equal(unlinked.files.has(`${PM2_HOME}/collab-stop.json`), false);
  assert.equal(await guardPm2(base(unlinked.io)), 1);
});

test("reader uses the target cgroup, not the caller cgroup", async () => {
  const box = world();
  const seen = [];
  box.io.listCgroupPids = (root) => {
    seen.push(root);
    if (root === CALLER) {
      return [99];
    }
    return [11];
  };
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  const obs = await observeTarget({
    io: box.io,
    pm2Home: PM2_HOME,
    unitCgroup: UNIT,
    uid: 1000,
    home: HOME,
    excludePids: [1],
  }, false);
  assert.deepEqual(seen, [UNIT]);
  assert.deepEqual(obs.service.map((id) => id.pid), [11]);
  assert.equal(JSON.stringify(obs).includes(SECRET), false);
});

test("daemon without rpc is an error and does not spawn a cli", async () => {
  const box = world();
  box.rpc = false;
  assert.equal(await stopPm2(base(box.io)), 1);
  assert.equal(box.killCalls, 0);
  assert.equal(box.jlistCalls.length, 0);
  assert.equal(box.receipt().confirmed, false);
  assert.equal(box.logs.join("\n").includes(SECRET), false);
});

test("guard excludes its own control chain (helper bash, flock, bash -c) but not other unit processes", async () => {
  // Measured on Lima 21/10: inside the unit, the guard saw its parent helper bash and refused every start.
  const statWithParent = (pid, ppid, startTime) =>
    `${pid} (bash) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime}\n`;
  const box = world();
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  box.rpc = false;
  box.cgroup.clear();
  for (const [pid, ppid, start] of [[100, 1, 3000], [101, 100, 3001], [102, 101, 3002], [103, 102, 3003]]) {
    box.procs.set(pid, { stat: statWithParent(pid, ppid, start), status: status(1000), environ: environ() });
    box.cgroup.add(pid);
  }
  assert.deepEqual(controlChain(box.io, 103), [103, 102, 101, 100]);
  const chain = controlChain(box.io, 103);
  assert.equal(await guardPm2(base(box.io, { helperPid: 103, controlPids: chain })), 0);
  // Only the guard itself excluded (the old behavior): the helper chain looks like a leftover and blocks.
  assert.equal(await guardPm2(base(box.io, { helperPid: 103, controlPids: [103] })), 1);
  // A real leftover outside the chain still blocks the start.
  box.procs.set(200, { stat: statWithParent(200, 1, 4000), status: status(1000), environ: environ() });
  box.cgroup.add(200);
  assert.equal(await guardPm2(base(box.io, { helperPid: 103, controlPids: chain })), 1);
});

test("stop does not wait for its own lock holder (flock and node -e children of the helper)", async () => {
  // Measured on Lima 21/10: the stop counted its own flock/node -e lock holder as service and always timed out.
  const withParent = (pid, ppid, startTime) =>
    `${pid} (node) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime}\n`;
  const box = world();
  const HELPER = 500;
  box.cgroup.delete(1); // world() puts the default helper (pid 1) in the cgroup; here the helper is 500
  box.procs.set(HELPER, { stat: withParent(HELPER, 1, 100), status: status(1000), environ: environ() });
  for (const [pid, ppid] of [[501, HELPER], [502, 501]]) {
    box.procs.set(pid, { stat: withParent(pid, ppid, 200 + pid), status: status(1000), environ: environ() });
    box.cgroup.add(pid);
  }
  box.cgroup.add(HELPER);
  assert.deepEqual(ownDescendants(box.io, UNIT, HELPER).sort(), [501, 502]);
  let sleeps = 0;
  const inner = box.io.sleep.bind(box.io);
  box.io.sleep = async (ms) => {
    sleeps += 1;
    if (sleeps === 1) {
      box.finish(0);
      box.procs.delete(10);
      box.procs.delete(11);
      box.files.delete(`${PM2_HOME}/pm2.pid`);
      box.cgroup.delete(10);
      box.cgroup.delete(11);
    }
    await inner(ms);
  };
  // The lock holder 501/502 stays alive for the whole stop; only the service (10, 11) leaves.
  assert.equal(await stopPm2(base(box.io, { helperPid: HELPER, controlPids: [HELPER] })), 0);
  assert.equal(box.receipt().confirmed, true);
});

function nodeStat(isSymlink, kind, uid = 1000) {
  return {
    uid,
    isSymbolicLink: () => isSymlink,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSocket: () => kind === "socket",
  };
}

test("live daemon without a pidfile and outside the cgroup refuses start", async () => {
  const box = world();
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  box.rpc = false;
  box.cgroup.clear();
  box.cgroup.add(1);
  box.procs.set(77, {
    stat: statLine(77, "PM2", 4242),
    status: status(1000),
    environ: environ(),
  });
  box.io.listProcPids = () => [1, 77];
  assert.equal(await guardPm2(base(box.io, { helperPid: 1, controlPids: [1] })), 1);
  assert.equal(box.killCalls, 0);
  assert.equal(box.jlistCalls.length, 0);
  assert.equal(box.logs.some((line) => line.includes("pid=77")), true);
});

test("reused pid, other home, and other uid are not the pm2 target", async () => {
  const box = world();
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  box.rpc = false;
  box.cgroup.clear();
  box.cgroup.add(1);
  box.procs.set(11, {
    stat: statLine(11, "node", 9999),
    status: status(1000),
    environ: environ("/elsewhere"),
  });
  box.procs.set(12, {
    stat: statLine(12, "PM2", 50),
    status: status(9),
    environ: environ(),
  });
  box.procs.set(13, {
    stat: statLine(13, "node", 2000),
    status: status(1000),
    environ: environ(),
  });
  box.io.listProcPids = () => [11, 12, 13];
  box.io.realpath = (file) => (file === PM2_HOME || file === "/link/.pm2" ? "/real/pm2" : file);
  box.procs.get(13).environ = `HOME=${HOME}\0PM2_HOME=/link/.pm2\0`;
  box.procs.get(13).stat = statLine(13, "node", 7777);
  const obs = await observeTarget(base(box.io, { helperPid: 1, controlPids: [1], excludePids: [1] }), false);
  assert.deepEqual(obs.service.map((id) => id.pid), [13]);
  assert.equal(obs.service[0].startTime, 7777);
  assert.equal(obs.daemon, null);
  box.procs.delete(13);
  box.io.listProcPids = () => [11, 12];
  assert.equal(await guardPm2(base(box.io, { helperPid: 1, controlPids: [1] })), 0);
  assert.equal(box.killCalls, 0);
});

test("an incomplete proc scan is unconfirmed and does not look like absence", async () => {
  const box = world();
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  box.cgroup.clear();
  box.cgroup.add(1);
  box.io.listProcPids = () => {
    throw new Error("short read");
  };
  assert.equal(await guardPm2(base(box.io, { helperPid: 1, controlPids: [1] })), 1);
  assert.equal(box.killCalls, 0);
  assert.equal(box.jlistCalls.length, 0);
});

test("start timeout does not call pm2 or record a graceful stop", async () => {
  const box = world();
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  box.rpc = false;
  box.cgroup.clear();
  box.cgroup.add(1);
  box.io.listProcPids = () => [];
  box.files.set(`${PM2_HOME}/collab-stop.json`, JSON.stringify({
    bootId: BOOT,
    phase: "stopping",
    confirmed: false,
    identities: [procIdentity(BOOT, 11, 2000)],
  }));
  const unlinked = [];
  box.io.lstat = (file) => {
    if (file === PM2_HOME) {
      return nodeStat(false, "dir");
    }
    if (file === "/real/pm2/pm2.pid") {
      return nodeStat(false, "file");
    }
    const error = new Error("gone");
    error.code = "ENOENT";
    throw error;
  };
  box.io.realpath = () => "/real/pm2";
  box.io.unlink = (file) => {
    unlinked.push(file);
  };
  assert.equal(await verifyPostStop(base(box.io, {
    helperPid: 1,
    controlPids: [1],
    serviceResult: "timeout",
    exitCode: "killed",
    exitStatus: "TERM",
  })), 0);
  assert.equal(box.killCalls, 0);
  assert.equal(box.jlistCalls.length, 0);
  assert.equal(box.receipt().confirmed, false);
  assert.equal(box.receipt().phase, "stopping");
  assert.deepEqual(unlinked, ["/real/pm2/pm2.pid"]);
});

test("a symlink artifact is left in place", async () => {
  const box = world();
  box.files.delete(`${PM2_HOME}/pm2.pid`);
  box.cgroup.clear();
  box.cgroup.add(1);
  box.io.listProcPids = () => [];
  let unlinked = 0;
  box.io.lstat = (file) => {
    if (file === PM2_HOME) {
      return nodeStat(false, "dir");
    }
    return nodeStat(true, "file");
  };
  box.io.realpath = () => "/real/pm2";
  box.io.unlink = () => {
    unlinked += 1;
  };
  assert.equal(await verifyPostStop(base(box.io, {
    helperPid: 1,
    controlPids: [1],
    serviceResult: "success",
  })), 1);
  assert.equal(unlinked, 0);
  assert.equal(box.killCalls, 0);
});

test("a stopped app listed with pid 0 is not a live process and not an inconsistent inventory", () => {
  const rows = [
    { name: "app", pid: 0, pm2_env: { status: "stopped" } },
    { name: "msg", pid: 4242, pm2_env: { status: "online" } },
  ];
  assert.deepEqual(pidsFromJlist(rows), [4242]);
  assert.deepEqual(pidsFromJlist([{ pid: 0 }, { pid: 0 }]), []);
  for (const bad of [{ pid: -1 }, { pid: 1.5 }, { pid: "x" }, null]) {
    assert.throws(() => pidsFromJlist([bad]), /inventory|jlist/);
  }
});
