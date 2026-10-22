#!/usr/bin/env node
/**
 * Passive PM2 reader. Never calls Client.start / API.connect / jlist.
 * Connects only to an existing rpc.sock via axon RPC getMonitorData.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  unavailable: 3,
  unsupported: 4,
});

export const LIST_TIMEOUT_MS = 5_000;

const LIST_FIELDS = Object.freeze({
  top: ["pm_id", "name", "pid"],
  monit: ["cpu", "memory"],
  env: ["status", "pm_uptime", "restart_time", "exec_mode", "pmx_module"],
});

class UnavailableError extends Error {
  constructor(message = "unavailable") {
    super(message);
    this.name = "UnavailableError";
    this.code = "unavailable";
    this.exitCode = EXIT.unavailable;
  }
}

class UnsupportedError extends Error {
  constructor(message = "unsupported") {
    super(message);
    this.name = "UnsupportedError";
    this.code = "unsupported";
    this.exitCode = EXIT.unsupported;
  }
}

function fail(err) {
  if (err instanceof UnavailableError || err instanceof UnsupportedError) {
    return err;
  }
  const wrapped = new UnavailableError(err && err.message ? err.message : "unavailable");
  return wrapped;
}

export function normalizeProcess(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const monitSrc = row.monit && typeof row.monit === "object" ? row.monit : {};
  const envSrc = row.pm2_env && typeof row.pm2_env === "object" ? row.pm2_env : {};
  const pid = row.pid == null ? 0 : Number(row.pid);
  if (!Number.isFinite(pid)) {
    return null;
  }
  return {
    pm_id: row.pm_id,
    name: row.name,
    pid,
    monit: {
      cpu: monitSrc.cpu,
      memory: monitSrc.memory,
    },
    pm2_env: {
      status: envSrc.status,
      pm_uptime: envSrc.pm_uptime,
      restart_time: envSrc.restart_time,
      exec_mode: envSrc.exec_mode,
      pmx_module: envSrc.pmx_module,
    },
  };
}

export function normalizeList(rows) {
  if (!Array.isArray(rows)) {
    throw new UnavailableError("invalid-monitor-data");
  }
  const out = [];
  for (const row of rows) {
    const n = normalizeProcess(row);
    if (n) {
      out.push(n);
    }
  }
  return out;
}

export function resolvePm2Root(pm2Bin, io = defaultIo()) {
  if (!pm2Bin || typeof pm2Bin !== "string") {
    throw new UnavailableError("pm2-bin-missing");
  }
  let resolved;
  try {
    resolved = io.realpathSync(pm2Bin);
  } catch {
    throw new UnavailableError("pm2-bin-unreadable");
  }
  let dir = path.dirname(resolved);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (io.existsSync(pkgPath)) {
      let pkg;
      try {
        pkg = JSON.parse(io.readFileSync(pkgPath, "utf8"));
      } catch {
        throw new UnsupportedError("package-unreadable");
      }
      if (pkg && pkg.name === "pm2") {
        return { root: dir, bin: resolved, version: String(pkg.version || ""), pkgPath };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new UnsupportedError("pm2-package-not-found");
}

export function readPm2Version(pm2Bin, io = defaultIo()) {
  const found = resolvePm2Root(pm2Bin, io);
  if (!found.version) {
    throw new UnsupportedError("version-missing");
  }
  return found.version;
}

function rpcSocketPath(pm2Home) {
  if (!pm2Home || typeof pm2Home !== "string") {
    throw new UnavailableError("pm2-home-missing");
  }
  return path.join(pm2Home, "rpc.sock");
}

function assertExistingSocket(rpcPath, io) {
  let st;
  try {
    st = io.lstatSync(rpcPath);
  } catch {
    throw new UnavailableError("rpc-sock-absent");
  }
  if (typeof st.isSocket === "function" ? !st.isSocket() : !st.isSocket) {
    throw new UnavailableError("rpc-sock-not-socket");
  }
}

function requireFromPm2Lib(pm2Root) {
  const libClient = path.join(pm2Root, "lib", "Client.js");
  const req = createRequire(libClient);
  return (rel) => req(rel);
}

export function defaultIo() {
  return {
    realpathSync: fs.realpathSync,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    lstatSync: fs.lstatSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    spawnSync() {
      throw new Error("pm2-readonly must not spawn");
    },
  };
}

/**
 * Connect to an existing rpc.sock and call getMonitorData.
 * Axon req sockets retry by default; retry is disabled so a dead daemon
 * cannot be revived and timers are always cleared.
 */
export async function axonGetMonitorData({ pm2Root, rpcPath, timeoutMs }) {
  const requirePm2 = requireFromPm2Lib(pm2Root);
  let axon;
  let axonRpc;
  try {
    axon = requirePm2("../modules/pm2-axon");
    axonRpc = requirePm2("../modules/pm2-axon-rpc");
  } catch {
    throw new UnsupportedError("axon-modules-missing");
  }
  const req = axon.socket("req");
  if (typeof req.set === "function") {
    req.set("retry timeout", 0);
    req.set("retry max", 0);
  }
  const client = new axonRpc.Client(req);
  let sock;
  let timer;
  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      if (sock && typeof sock.close === "function") {
        sock.close();
      } else if (req && typeof req.close === "function") {
        req.close();
      }
    } catch {
      /* ignore */
    }
    try {
      if (req && typeof req.destroy === "function") {
        req.destroy();
      }
    } catch {
      /* ignore */
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, data) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (err) {
        reject(fail(err));
      } else {
        resolve(data);
      }
    };
    timer = setTimeout(() => {
      done(new UnavailableError("timeout"));
    }, timeoutMs);

    const onFail = () => done(new UnavailableError("rpc-connect"));
    if (req && req.once) {
      req.once("reconnect attempt", onFail);
      req.once("error", onFail);
    }

    const onConnect = () => {
      if (!client || typeof client.call !== "function" && typeof client.request !== "function") {
        if (client && client.sock) {
          /* axon-rpc Client exposes .call via generate methods after connect */
        }
      }
      const invoke = (cb) => {
        if (typeof client.call === "function") {
          try {
            return client.call("getMonitorData", {}, cb);
          } catch {
            /* fall through */
          }
        }
        if (typeof client.request === "function") {
          return client.request("getMonitorData", {}, cb);
        }
        if (client && typeof client.getMonitorData === "function") {
          return client.getMonitorData({}, cb);
        }
        return cb(new UnavailableError("rpc-client"));
      };
      invoke((err, list) => {
        if (err) {
          done(new UnavailableError("getMonitorData"));
          return;
        }
        done(null, list);
      });
    };

    if (req.once) {
      req.once("connect", onConnect);
    }
    try {
      sock = req.connect(rpcPath);
    } catch (err) {
      done(fail(err));
    }
  });
}

export async function listPm2({
  pm2Bin,
  pm2Home,
  io = defaultIo(),
  transport,
  timeoutMs = LIST_TIMEOUT_MS,
}) {
  const found = resolvePm2Root(pm2Bin, io);
  const rpcPath = rpcSocketPath(pm2Home);
  assertExistingSocket(rpcPath, io);
  const run =
    transport ||
    ((opts) => axonGetMonitorData({ ...opts, pm2Root: found.root, rpcPath, timeoutMs }));
  let rows;
  try {
    rows = await run({
      pm2Root: found.root,
      rpcPath,
      timeoutMs,
      pm2Home,
      pm2Bin: found.bin,
    });
  } catch (err) {
    throw fail(err);
  }
  return normalizeList(rows);
}

export async function main(argv = process.argv.slice(2), env = process.env, io = defaultIo()) {
  const cmd = argv[0];
  const pm2Bin = argv[1];
  if (cmd !== "list" && cmd !== "version") {
    process.stderr.write("usage: pm2-readonly.mjs list|version <pm2-bin>\n");
    return EXIT.usage;
  }
  if (!pm2Bin) {
    process.stderr.write("usage: pm2-readonly.mjs list|version <pm2-bin>\n");
    return EXIT.usage;
  }
  try {
    if (cmd === "version") {
      const version = readPm2Version(pm2Bin, io);
      process.stdout.write(`${version}\n`);
      return EXIT.ok;
    }
    const pm2Home = env.PM2_HOME;
    if (!pm2Home) {
      process.stderr.write("unavailable\n");
      return EXIT.unavailable;
    }
    const rows = await listPm2({ pm2Bin, pm2Home, io });
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return EXIT.ok;
  } catch (err) {
    const code = err && err.exitCode ? err.exitCode : EXIT.unavailable;
    process.stderr.write(`${err && err.code ? err.code : "unavailable"}\n`);
    return code;
  }
}

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  main().then((code) => {
    process.exit(code);
  });
}

void LIST_FIELDS;
