# collab-runtime

Production VM bootstrap installer for Ubuntu 24.04 LTS.

## Overview

`collab-runtime` installs and configures the full server stack needed to run
Collab applications on a fresh Ubuntu 24.04 LTS VM.

### What it installs

| Component      | Version  | Notes                                    |
|----------------|----------|------------------------------------------|
| Ubuntu updates | latest   | Full dist-upgrade                        |
| NGINX          | latest   | From Ubuntu apt                          |
| PostgreSQL     | 17       | From PGDG official repo                  |
| TimescaleDB    | 2.x      | Community edition (packagecloud.io)      |
| Redis          | latest   | From official Redis apt repo             |
| Node.js        | 24.x     | System-wide via NodeSource               |
| 7-Zip          | latest   | p7zip-full + p7zip-rar                   |
| PM2            | latest   | Global npm install with systemd startup  |

### What it does NOT install

- SSL certificates (run `certbot` / `install-ssl.sh` separately)
- Client application code (deploy separately via PM2)

---

## Requirements

- **OS**: Ubuntu 24.04 LTS (Noble Numbat) — hard requirement, exits on anything else
- **Privileges**: must be run as root (`sudo ./install.sh`)
- **Network**: outbound internet access required to download packages

Also works inside a **Lima VM** on macOS M4 (aarch64).

---

## Usage

```bash
# Clone the repo on your target server
git clone https://github.com/collabcodes/collab-runtime.git
cd collab-runtime

# Run with the default (medium) profile
sudo ./install.sh

# Run with a specific profile
sudo ./install.sh --profile=small
sudo ./install.sh --profile=enterprise
```

---

## Profiles

| Profile    | RAM target | Typical instance            |
|------------|------------|-----------------------------|
| small      | 1–2 GB     | t3.small, e2-small, B1ms    |
| medium     | 4–8 GB     | t3.medium, e2-standard-2    |
| enterprise | 32+ GB     | m6i.2xlarge, n2-standard-8  |

Profile files live in `profiles/<name>/profile.conf`.
Each profile defines `PG_VERSION`, `NODE_VERSION`, and tuning parameters.

---

## Logs

| File                                    | Contents                  |
|-----------------------------------------|---------------------------|
| `/var/log/collab/install-summary.log`   | Key events only           |
| `/var/log/collab/install-detail.log`    | Full output from all steps |

---

## collab CLI

After installation, the `collab` CLI is available at `/usr/local/bin/collab`.

```
collab status              # show service health + versions
collab logs                # last 50 lines of install-summary.log
collab logs --detail       # last 50 lines of install-detail.log
collab doctor              # PASS/FAIL check for all components
collab update --check      # show available apt upgrades (dry-run)
collab update --apply      # apply apt upgrades
```

---

## Directory structure

```
collab-runtime/
├── install.sh                 # Main entry point
├── collab                     # CLI source (installed to /usr/local/bin)
├── core/
│   ├── check-os.sh            # Ubuntu 24.04 LTS validation
│   ├── logger.sh              # Logging utilities
│   └── utils.sh               # Shared helper functions
├── scripts/
│   ├── 01-ubuntu-update.sh
│   ├── 02-install-nginx.sh
│   ├── 03-install-postgres.sh
│   ├── 04-install-timescaledb.sh
│   ├── 05-install-redis.sh
│   ├── 06-install-node.sh
│   ├── 07-install-7zip.sh
│   └── 08-install-pm2.sh
├── profiles/
│   ├── small/profile.conf
│   ├── medium/profile.conf
│   └── enterprise/profile.conf
└── providers/
    ├── aws/README.md
    ├── azure/README.md
    └── gcp/README.md
```

---

## Next steps after install

1. **Configure SSL** — use Certbot or your provider's certificate service
2. **Deploy your app** — use `pm2 start` and `pm2 save`
3. **Create a PostgreSQL database** — `sudo -u postgres createdb myapp`
4. **Harden the server** — review UFW rules, SSH keys, fail2ban

---

## Lima (macOS M4) usage

```bash
limactl start --name=collab template://ubuntu-24.04
limactl shell collab
# inside Lima:
git clone https://github.com/collabcodes/collab-runtime.git
cd collab-runtime
sudo ./install.sh --profile=small
```
