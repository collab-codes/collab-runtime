#!/usr/bin/env node
// Writes the `db` block of the collab-messages appconfig.json (rt231): the Postgres the cm uses.
//
//   node msg-cm-db.mjs --appconfig <file> --password-file <file> [--host 127.0.0.1] [--port 5432] [--database cm] [--user cm]
//
// Only when the block does not exist: an existing `db` (any content) is left as it is. The password is read from a file made on this
// machine (step 14) and never printed. Output: `db created keys=…` or `db kept`.
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson } from "./msg-configure.mjs";

export function parseDbArgs(argv) {
  const out = { appconfig: "", passwordFile: "", host: "127.0.0.1", port: 5432, database: "cm", user: "cm" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--appconfig") out.appconfig = next();
    else if (arg === "--password-file") out.passwordFile = next();
    else if (arg === "--host") out.host = next();
    else if (arg === "--port") out.port = Number.parseInt(next(), 10);
    else if (arg === "--database") out.database = next();
    else if (arg === "--user") out.user = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!out.appconfig) throw new Error("--appconfig is required");
  if (!out.passwordFile) throw new Error("--password-file is required");
  if (!Number.isInteger(out.port) || out.port <= 0) throw new Error("--port must be a positive integer");
  return out;
}

/** `kept` when appconfig already has a `db` block; `created` after writing it. Never returns or throws the password. */
export function ensureDbBlock(opts, deps = {}) {
  if (!existsSync(opts.appconfig)) throw new Error(`appconfig.json not found: ${opts.appconfig}`);
  let current;
  try {
    current = JSON.parse(readFileSync(opts.appconfig, "utf8"));
  } catch {
    throw new Error("appconfig.json is not JSON");
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("appconfig.json must be a JSON object");
  }
  if (Object.prototype.hasOwnProperty.call(current, "db")) return { action: "kept", keys: [] };
  const password = existsSync(opts.passwordFile) ? readFileSync(opts.passwordFile, "utf8").trim() : "";
  if (!password) throw new Error(`password file is missing or empty: ${opts.passwordFile}`);
  const block = { host: opts.host, port: opts.port, database: opts.database, user: opts.user, password };
  (deps.write ?? atomicWriteJson)(opts.appconfig, { ...current, db: block });
  return { action: "created", keys: Object.keys(block) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = ensureDbBlock(parseDbArgs(process.argv.slice(2)));
    process.stdout.write(result.action === "created" ? `db created keys=${result.keys.join(",")}\n` : "db kept\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
