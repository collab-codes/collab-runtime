#!/usr/bin/env node
// notice-test-receiver.mjs — a stand-in for the sites, to prove the release notices end to end without touching it.
//
//   node scripts/notice-test-receiver.mjs --port 5199 [--fail-first 1] [--out /tmp/notices.jsonl]
//
// POST /api/v1/servers/<id>/events : answers 503 to the first N calls (--fail-first) and 200 afterwards; every accepted
// body is appended to --out (one JSON per line) with its idempotency key (vmId + projetoId + releaseId + code) and how
// many times that key was seen. POST /api/v1/servers/<id>/heartbeat : 200. It checks the contract version of the
// record in `details` (versaoContrato 2) and answers 400 with the reason otherwise.

import { appendFileSync } from "node:fs";
import http from "node:http";

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const port = Number(flag("--port", "5199"));
const failFirst = Number(flag("--fail-first", "0"));
const out = flag("--out", "/tmp/notices.jsonl");
let events = 0;
const seen = new Map();

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const reply = (status, body = {}) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return reply(405);
    if (/\/heartbeat$/u.test(req.url ?? "")) return reply(200, { ok: true });
    if (!/\/events$/u.test(req.url ?? "")) return reply(404);
    events += 1;
    if (events <= failFirst) return reply(503, { error: "receiver says try again" });
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(400, { error: "body is not JSON" });
    }
    const details = body.details ?? {};
    if (String(body.code ?? "").startsWith("release.") && details.versaoContrato !== 2) {
      return reply(400, { error: `versaoContrato ${details.versaoContrato} is not accepted; send 2` });
    }
    const key = [details.vmId, details.projetoId, details.releaseId, body.code].join("|");
    seen.set(key, (seen.get(key) ?? 0) + 1);
    appendFileSync(out, `${JSON.stringify({ key, vezes: seen.get(key), code: body.code, level: body.level, fila: details.fila, projetoId: details.projetoId, releaseId: details.releaseId, resultado: details.resultado, passos: (details.passos ?? []).map((p) => p.nome), temToken: Boolean(body.token) })}\n`);
    return reply(200, { ok: true });
  });
});

server.listen(port, "127.0.0.1", () => console.log(`notice receiver on 127.0.0.1:${port}, out ${out}, fail-first ${failFirst}`));
