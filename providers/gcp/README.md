# GCP — collab-runtime Provider Notes

## Recommended machine types

| Profile    | Machine type      | vCPU | RAM   |
|------------|-------------------|------|-------|
| small      | e2-small          | 2    | 2 GB  |
| medium     | e2-standard-2     | 2    | 8 GB  |
| enterprise | n2-standard-8     | 8    | 32 GB |

## Boot disk image

Use the official **Ubuntu 24.04 LTS** image from the `ubuntu-os-cloud` project:

```bash
gcloud compute images list --filter="family=ubuntu-2404-lts" \
  --project=ubuntu-os-cloud --no-standard-images
```

## Firewall rules

Create firewall rules to allow:

| Rule name           | Port | Protocol | Target        |
|---------------------|------|----------|---------------|
| allow-ssh           | 22   | TCP      | your source IP |
| allow-http          | 80   | TCP      | 0.0.0.0/0     |
| allow-https         | 443  | TCP      | 0.0.0.0/0     |

PostgreSQL (5432) and Redis (6379) should not be exposed externally.
Use Cloud SQL Proxy or VPC peering for managed alternatives.

## Persistent disk

Attach a separate persistent disk for data (balanced or SSD PD).
Mount at `/data` and symlink `/var/lib/postgresql` → `/data/postgresql`,
`/var/lib/redis` → `/data/redis`.

## Quick start

```bash
git clone https://github.com/collab-codes/collab-runtime.git
cd collab-runtime
sudo ./install.sh --profile=medium
```
