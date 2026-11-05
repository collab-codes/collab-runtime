// Boot aggregator of the pm2 "apps" config (rt182). Installed by 08-install-pm2.sh as <data>/etc/pm2.apps.config.js;
// the pm2-ubuntu drop-in starts it, so the boot never names a tree.
// Order: the project trees <data>/app<id>/mls-base/pm2.apps.d first, then the old shared tree <data>/mls-base/pm2.apps.d,
// only for the app names not seen yet: a migrated project wins. A reverted project has its app config renamed
// *.config.js.revertido (migrateToProjectTree --revert), which the filter below skips.
const { existsSync, readdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const dataRoot = dirname(__dirname);
const APP_TREE = /^app\d+$/u;

function configFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".config.js")).sort().map((name) => join(dir, name));
}

const dirs = (existsSync(dataRoot) ? readdirSync(dataRoot) : [])
  .filter((entry) => APP_TREE.test(entry))
  .sort()
  .map((entry) => join(dataRoot, entry, "mls-base", "pm2.apps.d"));
dirs.push(join(dataRoot, "mls-base", "pm2.apps.d"));

const seen = new Set();
const apps = [];
for (const dir of dirs) {
  for (const file of configFiles(dir)) {
    const loaded = require(file);
    for (const app of Array.isArray(loaded) ? loaded : loaded.apps ?? [loaded]) {
      if (seen.has(app.name)) continue;
      seen.add(app.name);
      apps.push(app);
    }
  }
}

if (apps.length === 0) console.error("pm2 boot: no project apps found");

module.exports = { apps };
