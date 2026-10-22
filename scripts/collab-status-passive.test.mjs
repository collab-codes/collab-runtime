import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const collab = join(root, "collab");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "collab-status-passive-"));
  const pkgDir = join(dir, "pm2-install");
  const binDir = join(pkgDir, "bin");
  const bin = join(binDir, "pm2");
  const called = join(dir, "pm2-called");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "pm2", version: "5.4.2" }));
  writeFileSync(bin, `#!/bin/sh\necho executed >> "${called}"\nexit 99\n`);
  chmodSync(bin, 0o755);
  return { dir, binDir, bin, called, home: join(dir, "must-not-exist-home") };
}

function runCollab(fx, args) {
  return spawnSync(collab, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: fx.dir,
    },
  });
}

test("status, doctor and msg status never execute pm2", () => {
  const fx = fixture();
  try {
    assert.equal(existsSync(fx.home), false);
    for (const args of [["status"], ["doctor"], ["msg", "status"]]) {
      const result = runCollab(fx, args);
      assert.notEqual(result.error, "ENOENT", result.stderr);
      assert.equal(existsSync(fx.called), false, `${args.join(" ")} executed pm2\n${result.stdout}\n${result.stderr}`);
    }
    assert.equal(existsSync(fx.home), false);
    assert.equal(existsSync(join(fx.home, "rpc.sock")), false);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("status and doctor show the package version and msg status shows unavailable", () => {
  const fx = fixture();
  try {
    const status = runCollab(fx, ["status"]);
    assert.match(status.stdout, /pm2\s+5\.4\.2/);
    assert.doesNotMatch(status.stdout, /unavailable/);

    const doctor = runCollab(fx, ["doctor"]);
    assert.match(doctor.stdout, /pm2 5\.4\.2 found/);

    const msg = runCollab(fx, ["msg", "status"]);
    assert.match(msg.stdout, /pm2 unavailable/);
    assert.match(msg.stdout, /installed version|no installed version recorded/);
    assert.equal(existsSync(fx.called), false);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("status reports unavailable when the pm2 binary is absent", () => {
  const fx = fixture();
  try {
    const result = spawnSync(collab, ["status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: fx.dir,
      },
    });
    assert.match(result.stdout, /pm2 unavailable/);
    assert.equal(existsSync(fx.called), false);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
