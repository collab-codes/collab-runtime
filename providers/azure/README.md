# Azure — collab-runtime Provider Notes

## Recommended VM sizes

| Profile    | VM size          | vCPU | RAM   |
|------------|------------------|------|-------|
| small      | Standard_B1ms    | 1    | 2 GB  |
| medium     | Standard_B2ms    | 2    | 8 GB  |
| enterprise | Standard_D8s_v5  | 8    | 32 GB |

## Image

Use the official **Ubuntu 24.04 LTS** Marketplace image:

- Publisher: `Canonical`
- Offer: `ubuntu-24_04-lts`
- SKU: `server`

```bash
az vm image list --publisher Canonical --offer ubuntu-24_04-lts --all
```

## Network Security Group

Open the following inbound rules:

| Priority | Port | Protocol | Source    | Purpose       |
|----------|------|----------|-----------|---------------|
| 100      | 22   | TCP      | your IP   | SSH           |
| 110      | 80   | TCP      | *         | HTTP (NGINX)  |
| 120      | 443  | TCP      | *         | HTTPS (NGINX) |

PostgreSQL (5432) and Redis (6379) should remain private.

## Storage

Attach a separate managed data disk for `/var/lib/postgresql` and `/var/lib/redis`.
Recommended: Premium SSD, at least 64 GB.

## Quick start

```bash
git clone https://github.com/collabcodes/collab-runtime.git
cd collab-runtime
sudo ./install.sh --profile=medium
```
