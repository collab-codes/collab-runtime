// scripts/vm-agent.mjs — the files of the sites agent installed on a VM, against the checkout (rt199).
//
// Shared by `collab vm inventory` (is the agent out of date?) and `collab vm update agente` (install it). The list is the
// one `install-shutdown.sh` copies; the first five run INSIDE the agent process, so only a change in them needs a restart of
// `collab-sites-agent` (the other three are used by the shutdown worker, a separate unit).

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

/**
 * Compare every installed file with its checkout copy. A file with no checkout copy is not compared (nothing to compare
 * against); a file missing on the machine counts as changed.
 *
 * @param {{ runtimeDir: string, prefix?: string, exists: (p: string) => boolean, hashOf: (p: string) => string }} input
 * @returns {{ changed: Array<{ file: string, reason: 'differs' | 'not-installed' }>, restartNeeded: boolean, installedMain: string, checkoutMain: string }}
 */
export function compareAgent({ runtimeDir, prefix = '', exists, hashOf }) {
  const changed = [];
  let restartNeeded = false;
  let installedMain = '';
  let checkoutMain = '';
  for (const entry of AGENT_FILES) {
    const checkout = join(runtimeDir, entry.src);
    const installed = join(prefix || '/', entry.dest);
    const main = entry.src === AGENT_FILES[0].src;
    if (!exists(checkout)) {
      if (main && exists(installed)) installedMain = hashOf(installed);
      continue;
    }
    const checkoutHash = hashOf(checkout);
    if (main) checkoutMain = checkoutHash;
    if (!exists(installed)) {
      changed.push({ file: entry.src, reason: 'not-installed' });
      if (entry.inProcess) restartNeeded = true;
      continue;
    }
    const installedHash = hashOf(installed);
    if (main) installedMain = installedHash;
    if (installedHash !== checkoutHash) {
      changed.push({ file: entry.src, reason: 'differs' });
      if (entry.inProcess) restartNeeded = true;
    }
  }
  return { changed, restartNeeded, installedMain, checkoutMain };
}
