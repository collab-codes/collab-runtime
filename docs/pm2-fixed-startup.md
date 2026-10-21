# PM2 boot from the canonical configs

Boot reads two config files. It does not read `dump.pm2` and it does not run `pm2 resurrect`.

`pm2 save` stays available for deploy and diagnosis. The historical root-to-deploy migration still copies a dump and may `resurrect` during that move, including the rollback that puts apps back on the root daemon. Those calls are not the systemd boot path.

`TimeoutStopSec=900s` is the systemd stop budget on the unit. It is larger than the biggest single `kill_timeout` in the current collab-messages config (660000 ms) and larger than an app worker (180000 ms). PM2 stops processes in series, so the sum can exceed one process budget. 900s does not change the provider power window and does not promise that every process drains.

A real `systemctl restart` on Lima is still a separate proof. This document is the install and rollback recipe. It does not claim that a remote boot was observed.

## Configs the helper starts

| Role | Path under `COLLAB_DATA_ROOT` (default `/data`) | Who writes it |
| --- | --- | --- |
| Apps | `mls-base/pm2.config.js` | `mls-base` `scripts/runtime/vmApps.mjs` (`ensureProjectApp`, aggregator over `pm2.apps.d`, two cluster workers per app) and `collab-sites` `buildPm2ConfigCommand` (one `pm2.apps.d/app<port>.config.js` per project). Removing a project is done by that producer. |
| collab-messages | `msg.collab.codes/pm2.config.js` | Step 11 downloads the release `pm2.config.js` onto `$ROOT`. Current file: `msg` × 2 cluster, plus `msg-worker` × 1 fork when `COLLAB_MESSAGES_ENABLE_WORKER` is not `false`. `kill_timeout` is 660000. The helper unsets only that variable for the messages command so the file default keeps the worker. |

There is no second project list. The helper starts each file that exists, with `start --update-env`. The same file is not started twice.

Provisioning (`install.sh` step 08) and `08-install-pm2.sh --startup-only` write the same helper and the same drop-ins.

## What boot does in each layout

- **Neither file present** (new disk, no release yet): `pm2 ping` only. The daemon is up and empty. That is not application health.
- **Apps file only:** start the apps config. Log the missing messages path. Do not pass `--only`.
- **Messages file only:** start the messages config. Log the missing apps path.
- **Both present:** apps config, then the messages config.
- **File present but unreadable, invalid, or PM2 exits non-zero:** the helper fails. There is no dump fallback and no silent success.

`pm2-logrotate` is a module, not an app in this inventory.

Do not copy credentials, a full `dump.pm2`, or a full `pm2 jlist` into tickets. Record process name, instances, status, and timings.

## Update an existing VM

This path does not install npm packages, run `pm2 startup`, migrate root, install logrotate, or restart apps.

Preflight, as root:

1. `command -v pm2` succeeds. `--startup-only` does not install PM2.
2. The unit `pm2-<deploy user>.service` already exists.
3. Its `User=` is the deploy user and `PM2_HOME` is that user's `~/.pm2`.
4. Its current `ExecStart=` begins with the absolute PM2 binary that should keep owning the daemon.

Deploy user defaults to the non-root owner of the data root. Override either one when this host is not the default:

```bash
sudo COLLAB_DATA_ROOT=/data COLLAB_DEPLOY_USER=ubuntu \
  bash /data/collab-runtime/scripts/08-install-pm2.sh --startup-only
```

Use the real data root and the real deploy user for that VM. An unknown flag exits 64 before any write.

Backup first (paths follow the unit name):

```bash
unit=pm2-ubuntu.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "/var/backups/pm2-startup-$stamp"
cp -a "/etc/systemd/system/$unit" "/var/backups/pm2-startup-$stamp/" 2>/dev/null || true
cp -a "/lib/systemd/system/$unit" "/var/backups/pm2-startup-$stamp/" 2>/dev/null || true
cp -a "/etc/systemd/system/${unit}.d" "/var/backups/pm2-startup-$stamp/drop-ins" 2>/dev/null || true
```

Then run the command above. It copies `scripts/pm2-start-fixed.sh` to `/usr/local/lib/collab/pm2-start-fixed.sh` (0755, root), writes `data-mount.conf` (`RequiresMountsFor` the data root) and `fixed-configs.conf`, then `systemctl daemon-reload` and `systemd-analyze verify`. A failure is an error. It does not print success over a failed check. Drop-ins other than these two files are left in place. The base unit keeps the `User`, `Environment=PM2_HOME`, `PATH`, `PIDFile`, `Type`, `ExecStop`, and `ExecReload` that `pm2 startup` wrote. `fixed-configs.conf` clears `ExecStart` and sets one helper line:

```text
ExecStart=
ExecStart="/usr/local/lib/collab/pm2-start-fixed.sh" "<pm2-binary>" "<data>/mls-base/pm2.config.js" "<data>/msg.collab.codes/pm2.config.js"
TimeoutStopSec=900s
```

Check the merged unit. Do not restart in this step.

```bash
systemctl cat pm2-ubuntu.service
systemctl show pm2-ubuntu.service -p User -p Environment -p ExecStart -p ExecStop -p TimeoutStopUSec -p PIDFile
systemd-analyze verify pm2-ubuntu.service
```

Expect one helper `ExecStart`, `TimeoutStopUSec=15min`, the deploy user, and that user's `PM2_HOME`. `ExecStop` stays the generated `pm2 kill`.

## Rollback

Restore the backup, reload, and verify again. Leave the running daemon alone until the restart window.

```bash
unit=pm2-ubuntu.service
cp -a "/var/backups/pm2-startup-$stamp/$unit" /etc/systemd/system/ 2>/dev/null || true
rm -rf "/etc/systemd/system/${unit}.d"
cp -a "/var/backups/pm2-startup-$stamp/drop-ins" "/etc/systemd/system/${unit}.d" 2>/dev/null || true
systemctl daemon-reload
systemd-analyze verify "$unit"
systemctl cat "$unit"
```

If the backup had no drop-in directory, the empty remove is the restored state. Do not point `ExecStart` at `resurrect` as a fallback for a bad config. Fix or remove the bad file, or restore the previous unit, then decide on a restart.

## Restart

Restart is a separate action, in a window that is already reserved. `--startup-only` must not be used as that restart.

```bash
sudo systemctl restart pm2-ubuntu.service
systemctl is-active pm2-ubuntu.service
```

After a restart, read names, instance counts, and status from the two config files and from process state. Compare HTTP `/health` only in that reserved proof. A clean restart with no traffic does not measure aggregate drain, a power cut, or the next cold boot.
