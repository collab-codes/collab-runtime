import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = `# managed by collab-runtime step 17
proxy_read_timeout 1900s;   # above collab-messages 30 minute LLM proxy wait
proxy_send_timeout 1900s;
send_timeout 1900s;
`;

function layout() {
  const prefix = mkdtempSync(join(tmpdir(), "rt308-nginx-"));
  const bin = join(prefix, "bin");
  mkdirSync(bin);
  const conf = join(prefix, "etc/nginx/conf.d/collab-proxy-timeouts.conf");
  return { prefix, bin, conf, log: join(bin, "systemctl.log") };
}

function stub(bin, { testOk, dumpConf, conf }) {
  writeFileSync(join(bin, "nginx"), `#!/bin/bash
if [[ "\$1" == "-t" ]]; then
  if [[ "${testOk ? "1" : "0"}" == "1" ]]; then exit 0; fi
  echo "nginx: [emerg] unexpected end of file, expecting ';' or '}'" >&2
  exit 1
fi
if [[ "\$1" == "-T" ]]; then
  if [[ "${dumpConf ? "1" : "0"}" == "1" ]]; then cat "${conf}"; exit 0; fi
  echo "http { }"
  exit 0
fi
exit 0
`);
  writeFileSync(join(bin, "systemctl"), `#!/bin/bash
echo "\$*" >> "${join(bin, "systemctl.log")}"
`);
  chmodSync(join(bin, "nginx"), 0o755);
  chmodSync(join(bin, "systemctl"), 0o755);
}

function run(env) {
  return execFileSync("bash", [join(root, "scripts/17-nginx-proxy-timeouts.sh")], {
    encoding: "utf8",
    env,
  });
}

test("17 escreve as quatro linhas e a segunda execução não reescreve nem recarrega", () => {
  const { prefix, bin, conf, log } = layout();
  stub(bin, { testOk: true, dumpConf: true, conf });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_NGINX_ROOT: prefix };
  const first = run(env);
  assert.equal(readFileSync(conf, "utf8"), EXPECTED);
  assert.match(first, /wrote /u);
  assert.match(readFileSync(log, "utf8"), /^reload nginx$/mu);
  const written = readFileSync(conf, "utf8");
  rmSync(log);
  const second = run(env);
  assert.equal(readFileSync(conf, "utf8"), written);
  assert.doesNotMatch(second, /wrote /u);
  assert.equal(existsSync(log), false);
});

test("nginx -t falhando desfaz o arquivo e devolve o erro", () => {
  const { prefix, bin, conf } = layout();
  stub(bin, { testOk: false, dumpConf: true, conf });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_NGINX_ROOT: prefix };
  mkdirSync(dirname(conf), { recursive: true });
  writeFileSync(conf, "send_timeout 60s;\n");
  let err;
  try {
    run(env);
  } catch (caught) {
    err = caught;
  }
  assert.ok(err);
  assert.notEqual(err.status, 0);
  assert.match(`${err.stderr}`, /unexpected end of file/u);
  assert.equal(readFileSync(conf, "utf8"), "send_timeout 60s;\n");
});

test("nginx -T sem as diretivas termina com erro", () => {
  const { prefix, bin, conf } = layout();
  stub(bin, { testOk: true, dumpConf: false, conf });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_NGINX_ROOT: prefix };
  let err;
  try {
    run(env);
  } catch (caught) {
    err = caught;
  }
  assert.ok(err);
  assert.notEqual(err.status, 0);
  assert.match(`${err.stderr}`, /nginx -T does not show/u);
  assert.equal(readFileSync(conf, "utf8"), EXPECTED);
});

test("install.sh e update-collab-runtime.sh chamam o passo 17", () => {
  const install = readFileSync(join(root, "install.sh"), "utf8");
  assert.ok(install.indexOf('"17-nginx-proxy-timeouts.sh"') > install.indexOf('"16-disk-cleanup-timers.sh"'));
  const update = readFileSync(join(root, "scripts/update-collab-runtime.sh"), "utf8");
  assert.match(update, /17-nginx-proxy-timeouts\.sh/u);
  assert.match(update, /STEPS="\$\{STEPS\},timeouts"/u);
});
