# AWS — collab-runtime Provider Notes

## Recommended instance types

| Profile    | Instance type | vCPU | RAM   |
|------------|---------------|------|-------|
| small      | t3.small      | 2    | 2 GB  |
| medium     | t3.medium     | 2    | 4 GB  |
| enterprise | m6i.2xlarge   | 8    | 32 GB |

## AMI

Use the official **Ubuntu 24.04 LTS** AMI from Canonical:

- Search for `ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*` in your region
- Owner: `099720109477` (Canonical)

## Security Group

Open the following inbound ports:

| Port | Protocol | Source    | Purpose         |
|------|----------|-----------|-----------------|
| 22   | TCP      | your IP   | SSH             |
| 80   | TCP      | 0.0.0.0/0 | HTTP (NGINX)    |
| 443  | TCP      | 0.0.0.0/0 | HTTPS (NGINX)   |

PostgreSQL (5432) and Redis (6379) should **not** be opened to the public internet.

## Storage

Attach a separate EBS volume for data (`/var/lib/postgresql`, `/var/lib/redis`)
to decouple OS and data lifecycles. Recommended: `gp3`, at least 50 GB.

## Quick start

```bash
git clone https://github.com/collabcodes/collab-runtime.git
cd collab-runtime
sudo ./install.sh --profile=medium
```
