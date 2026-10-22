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

Expect one helper `ExecStart`, one `pm2-lifecycle.mjs stop` `ExecStop`, `TimeoutStopUSec=15min`, the deploy user, and that user's `PM2_HOME`. See "Stop and restart" below.

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

## Stop and restart (lifecycle helper)

`--startup-only` and the normal step 08 both call `apply_pm2_fixed_startup`. That copies `pm2-start-fixed.sh` (0755) and `pm2-lifecycle.mjs` (0644) to `/usr/local/lib/collab`, root-owned, and writes the mount drop-in plus `fixed-configs.conf`. It then runs `systemctl daemon-reload` and `systemd-analyze verify`. It does not stop, restart, kill, save, install npm packages, or migrate a dump.

`node` and `flock` must already be on `PATH`. The installer checks both and does not download them. `ExecStop` records the absolute `node` from that check. The stop command runs as the unit user.

The base unit keeps `Type`, `PIDFile`, `User`, `PM2_HOME`, and `ExecReload`. The drop-in clears `ExecStart` and `ExecStop`, then sets:

```text
ExecStart=
ExecStart="/usr/local/lib/collab/pm2-start-fixed.sh" "<pm2-binary-from-the-unit>" "<data>/mls-base/pm2.config.js" "<data>/msg.collab.codes/pm2.config.js"
ExecStop=
ExecStop="<node>" "/usr/local/lib/collab/pm2-lifecycle.mjs" stop "<same-pm2-binary>"
TimeoutStopSec=900s
```

The PM2 binary is the one on the unit's `ExecStart`, not a `pm2` from another home. `RequiresMountsFor` stays on `data-mount.conf`. `pm2 startup` may rewrite the base unit; the drop-in still applies.

The helper's own budget is 840s monotonic, including the lock and the wait. It is inside `TimeoutStopSec=900s`. A timeout or a non-zero exit is not a clean stop. 900s does not promise that several serial drains finish, and it does not change the collab-messages `kill_timeout`.

`PM2_HOME/collab-lifecycle.lock` (0600) serializes this unit's start and stop entrypoints. It does not block every external PM2 CLI. `PM2_HOME/collab-stop.json` (0600) stores boot id, phase (`stopping` or `stopped`), and process identities. It does not store env, config, or tokens.

## Failed unit

Do not `start` or `restart` while a previous generation is still alive. Install does not do that. `systemctl stop` is the synchronous stop. If the unit is already `failed` and processes remain, leave them until `ExecStop` reports they are gone. A receipt left in `stopping`, or a receipt removed by hand, does not authorize the next start. The guard refuses a live daemon, a leftover process, or an unconfirmed stop.

## Verify

Use property names. Do not print `Environment` or the receipt body.

```bash
systemctl show pm2-ubuntu.service -p Id -p User -p ExecStart -p ExecStop -p TimeoutStopUSec -p PIDFile -p ActiveState -p SubState
systemd-analyze verify pm2-ubuntu.service
```

Expect the helper on `ExecStart`, `pm2-lifecycle.mjs stop` on `ExecStop` with the unit's PM2 binary, and `TimeoutStopUSec=15min`.

## Startup, health, and drain

These are different facts.

- **Startup** is the unit start. The helper budget is 80s monotonic, inside `TimeoutStartSec=90s`, and covers the lock plus both configs. The journal records `bootId` and the phase (`validate-home`, `lock`, `guard`, `apps`, `messages`, `done`) with start, end, monotonic duration, and exit code. A slow first boot is located by that phase. Passing the hook and unit tests does not name the cause of a previous 88s stall.
- **Recovery** is finite: `StartLimitIntervalSec=3600s`, `StartLimitBurst=3`, `Restart=on-failure`, `RestartSec=10s`, `KillMode=control-group`, `SendSIGKILL=yes`. Nothing in this install runs `reset-failed` or starts the unit again after the burst. `ExecStopPost` is `pm2-lifecycle.mjs post-stop`: it checks `SERVICE_RESULT` and leftover identities. It does not call `pm2 kill`, `jlist`, or `start`. A start killed by the kernel for timeout is not a graceful stop receipt.
- **Drain** is the synchronous `ExecStop` (`pm2-lifecycle.mjs stop`, `TimeoutStopSec=900s`). Online processes and a zero helper exit are not a drain.
- **Health** is HTTP `/health` of the real service, read only in a reserved proof. Unit `active`, a PM2 process `online`, or a present `dump.pm2` does not mean the app is healthy.

Automatic readers use one passive helper, installed at `/usr/local/lib/collab/pm2-readonly.mjs` (0644, root). The command is `node pm2-readonly.mjs list <pm2-bin>` with `PM2_HOME` set to the deploy user's home. It talks to the existing `rpc.sock` and does not call `Client.start` or `pm2 jlist`. A missing socket or a non-zero exit is unavailable, not an empty process list. The list keeps only `pm_id`, `name`, `pid`, `monit.cpu`, `monit.memory`, and `pm2_env.status`, `pm_uptime`, `restart_time`, `exec_mode`, `pmx_module`. `version <pm2-bin>` reads `package.json` and does not connect. The heartbeat may add `payload.boot` (`id`, `uptimeSeconds`) and `payload.pm2.unit` (`name`, `activeState`, `subState`, `result`, `nRestarts`). `ready` requires the unit `active` and a valid process read. Real PM2 and systemd versions are recorded by the Linux tester, not by this document.

`pm2 kill`, `stop`, `start`, `reload`, and `save` stay explicit mutations. They are not status checks.

## Backup and rollback

Back up only the files this install changes. Restore those files only. Do not copy `dump.pm2` back, and do not restart.

```bash
unit=pm2-ubuntu.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "/var/backups/pm2-startup-$stamp"
cp -a "/usr/local/lib/collab/pm2-start-fixed.sh" "/usr/local/lib/collab/pm2-lifecycle.mjs" "/var/backups/pm2-startup-$stamp/" 2>/dev/null || true
cp -a "/etc/systemd/system/${unit}.d/fixed-configs.conf" "/etc/systemd/system/${unit}.d/data-mount.conf" "/var/backups/pm2-startup-$stamp/" 2>/dev/null || true
```

```bash
cp -a "/var/backups/pm2-startup-$stamp/pm2-start-fixed.sh" "/var/backups/pm2-startup-$stamp/pm2-lifecycle.mjs" /usr/local/lib/collab/
cp -a "/var/backups/pm2-startup-$stamp/fixed-configs.conf" "/var/backups/pm2-startup-$stamp/data-mount.conf" "/etc/systemd/system/${unit}.d/"
systemctl daemon-reload
systemd-analyze verify "$unit"
```
