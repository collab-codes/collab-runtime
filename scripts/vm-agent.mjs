// scripts/vm-agent.mjs — the files of the sites agent installed on a VM, against the checkout (rt199).
//
// Shared by `collab vm inventory` (is the agent out of date?) and `collab vm update agente` (install it). The list is the
// one `install-shutdown.sh` copies; the first five run INSIDE the agent process, so only a change in them needs a restart of
// `collab-sites-agent` (the other three are used by the shutdown worker, a separate unit).

import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const AGENT_FILES = [
  { src: 'agent/collab-sites-agent.mjs', dest: 'usr/local/lib/collab-sites-agent/collab-sites-agent.mjs', inProcess: true },
  { src: 'agent/shutdown-state.mjs', dest: 'usr/local/lib/collab-sites-agent/shutdown-state.mjs', inProcess: true },
  { src: 'agent/shutdown-worker.mjs', dest: 'usr/local/lib/collab-sites-agent/shutdown-worker.mjs', inProcess: false },
  { src: 'agent/shutdown-services.mjs', dest: 'usr/local/lib/collab-sites-agent/shutdown-services.mjs', inProcess: true },
  { src: 'agent/release-notices.mjs', dest: 'usr/local/lib/collab-sites-agent/release-notices.mjs', inProcess: true },
  { src: 'scripts/pm2-lifecycle.mjs', dest: 'usr/local/lib/collab/pm2-lifecycle.mjs', inProcess: false },
  { src: 'scripts/pm2-readonly.mjs', dest: 'usr/local/lib/collab/pm2-readonly.mjs', inProcess: false },
  { src: 'scripts/pm2-stop-order.mjs', dest: 'usr/local/lib/collab/pm2-stop-order.mjs', inProcess: false },
];

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * What `install-shutdown.sh` leaves on the machine for a checkout file. It COPIES, then RETARGETS the imports of three of them
 * (the checkout imports the shared pm2 modules and `pm2-lifecycle` by repo-relative path, the installed copy by the stable library
 * path, prefix included). So the installed file is never byte-equal to the checkout's: comparing raw hashes called the agent
 * "out of date" forever and made every `vm update agente` reinstall and restart (found on the 102056, 09/11/2026). The rules are the
 * script's `retarget_lib_import` and the `pm2-lifecycle` sed, nothing else; a test runs the real script and expects no difference.
 */
export function expectedInstalled(text, srcRel, prefix = '') {
  const lib = join(prefix || '/', 'usr/local/lib/collab');
  const retarget = (content, name) => content
    .replaceAll(`from "./${name}"`, `from "${join(lib, name)}"`)
    .replaceAll(`from "../scripts/${name}"`, `from "${join(lib, name)}"`);
  switch (srcRel) {
    case 'agent/collab-sites-agent.mjs':
      return retarget(text, 'pm2-readonly.mjs');
    case 'agent/shutdown-services.mjs':
      return retarget(retarget(text, 'pm2-readonly.mjs'), 'pm2-stop-order.mjs')
        .replaceAll('from "../scripts/pm2-lifecycle.mjs"', `from "${join(lib, 'pm2-lifecycle.mjs')}"`);
    case 'scripts/pm2-lifecycle.mjs':
      return retarget(retarget(text, 'pm2-readonly.mjs'), 'pm2-stop-order.mjs');
    default:
      return text;
  }
}

/**
 * Compare every installed file with what the installer WOULD leave for its checkout copy. A file with no checkout copy is not
 * compared (nothing to compare against); a file missing on the machine counts as changed.
 *
 * @param {{ runtimeDir: string, prefix?: string, exists: (p: string) => boolean, readText: (p: string) => string }} input
 * @returns {{ changed: Array<{ file: string, reason: 'differs' | 'not-installed' }>, restartNeeded: boolean, installedMain: string, checkoutMain: string }}
 */
export function compareAgent({ runtimeDir, prefix = '', exists, readText }) {
  const changed = [];
  let restartNeeded = false;
  let installedMain = '';
  let checkoutMain = '';
  for (const entry of AGENT_FILES) {
    const checkout = join(runtimeDir, entry.src);
    const installed = join(prefix || '/', entry.dest);
    const main = entry.src === AGENT_FILES[0].src;
    if (!exists(checkout)) {
      if (main && exists(installed)) installedMain = sha12(readText(installed));
      continue;
    }
    const expectedHash = sha12(expectedInstalled(readText(checkout), entry.src, prefix));
    if (main) checkoutMain = expectedHash;
    if (!exists(installed)) {
      changed.push({ file: entry.src, reason: 'not-installed' });
      if (entry.inProcess) restartNeeded = true;
      continue;
    }
    const installedHash = sha12(readText(installed));
    if (main) installedMain = installedHash;
    if (installedHash !== expectedHash) {
      changed.push({ file: entry.src, reason: 'differs' });
      if (entry.inProcess) restartNeeded = true;
    }
  }
  return { changed, restartNeeded, installedMain, checkoutMain };
}
