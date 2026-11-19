import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const install = readFileSync(join(root, "install.sh"), "utf8");

function layout(prefix, { availKib = 4 * 1024 * 1024, active = false, fallocateFails = false } = {}) {
  const bin = join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(prefix, "log"), { recursive: true });
  const write = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  write("df", `#!/bin/bash
echo Avail
echo ${availKib}
`);
  write("swapon", `#!/bin/bash
state="${prefix}/swap-active"
if [[ "\${1:-}" == "--show" ]]; then
  if [[ -f "\$state" ]]; then cat "\$state"; fi
  exit 0
fi
printf '%s\n' "\$*" >> "${prefix}/swapon.log"
printf '%s\n' "\$1" > "\$state"
`);
  write("mkswap", `#!/bin/bash
printf '%s\n' "\$*" >> "${prefix}/mkswap.log"
`);
  write("fallocate", `#!/bin/bash
if [[ -f "${prefix}/fallocate-fail" ]]; then exit 1; fi
out=""
while [[ \$# -gt 0 ]]; do out="\$1"; shift; done
mkdir -p "\$(dirname "\$out")"
printf 'swap\n' > "\$out"
printf '%s\n' "\$out" >> "${prefix}/fallocate.log"
`);
  write("dd", `#!/bin/bash
out=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    of=*) out="\${1#of=}" ;;
  esac
  shift
done
mkdir -p "\$(dirname "\$out")"
printf 'swap\n' > "\$out"
printf '%s\n' "\$out" >> "${prefix}/dd.log"
`);
  write("sysctl", `#!/bin/bash
printf '%s\n' "\$*" >> "${prefix}/sysctl.log"
`);
  if (active) writeFileSync(join(prefix, "swap-active"), "/swapfile\n");
  if (fallocateFails) writeFileSync(join(prefix, "fallocate-fail"), "1");
  return bin;
}

function run(prefix, bin) {
  return execFileSync("bash", [join(root, "scripts/01b-swap.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      COLLAB_SWAP_ROOT: prefix,
      LOG_DIR: join(prefix, "log"),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

test("01b creates the swap file, fstab line and swappiness when swap is off", () => {
  const prefix = mkdtempSync(join(tmpdir(), "rt254-swap-"));
  const bin = layout(prefix);
  run(prefix, bin);
  assert.equal(readFileSync(join(prefix, "swapfile"), "utf8"), "swap\n");
  assert.match(readFileSync(join(prefix, "mkswap.log"), "utf8"), new RegExp(`${prefix}/swapfile`));
  assert.match(readFileSync(join(prefix, "swapon.log"), "utf8"), new RegExp(`${prefix}/swapfile`));
  assert.match(readFileSync(join(prefix, "etc/fstab"), "utf8"), new RegExp(`^${prefix}/swapfile none swap sw 0 0$`, "m"));
  assert.equal(readFileSync(join(prefix, "etc/sysctl.d/99-collab-swap.conf"), "utf8"), "vm.swappiness=10\n");
  assert.match(readFileSync(join(prefix, "sysctl.log"), "utf8"), /^--system$/m);
});

test("a second run does not duplicate the fstab line", () => {
  const prefix = mkdtempSync(join(tmpdir(), "rt254-swap-"));
  const bin = layout(prefix);
  run(prefix, bin);
  writeFileSync(join(prefix, "swap-active"), "");
  run(prefix, bin);
  const fstab = readFileSync(join(prefix, "etc/fstab"), "utf8");
  const line = `${prefix}/swapfile none swap sw 0 0`;
  assert.equal(fstab.split("\n").filter((row) => row === line).length, 1);
});

test("an active swap is left untouched", () => {
  const prefix = mkdtempSync(join(tmpdir(), "rt254-swap-"));
  const bin = layout(prefix, { active: true });
  run(prefix, bin);
  assert.equal(existsSync(join(prefix, "swapfile")), false);
  assert.equal(existsSync(join(prefix, "mkswap.log")), false);
  assert.equal(existsSync(join(prefix, "etc/fstab")), false);
  assert.equal(existsSync(join(prefix, "etc/sysctl.d/99-collab-swap.conf")), false);
});

test("too little free space fails and does not create the swap file", () => {
  const prefix = mkdtempSync(join(tmpdir(), "rt254-swap-"));
  const bin = layout(prefix, { availKib: 1024 });
  assert.throws(() => run(prefix, bin));
  assert.equal(existsSync(join(prefix, "swapfile")), false);
  assert.equal(existsSync(join(prefix, "mkswap.log")), false);
});

test("install.sh runs the swap step right after the Ubuntu update", () => {
  const update = install.indexOf('"01-ubuntu-update.sh"');
  const swap = install.indexOf('"01b-swap.sh"');
  const nginx = install.indexOf('"02-install-nginx.sh"');
  assert.ok(update > 0 && swap > update && nginx > swap);
});
