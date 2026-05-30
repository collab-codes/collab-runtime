# collab-runtime

Server environment installer for [collab.codes](https://collab.codes) production infrastructure.

## What it does

Prepares a fresh Ubuntu server with everything needed to run the collab.codes platform. Run it once on a new VM and the environment is ready.

## Requirements

- Ubuntu 24.04 LTS (officially supported)
- Root access

## Usage

```bash
cd /data
git clone https://github.com/collab-codes/collab-runtime
cd collab-runtime
[git pull] # optional, update
sudo ./install.sh
```

An optional profile can be specified to match the target VM size:

```bash
sudo ./install.sh --profile=small
sudo ./install.sh --profile=medium   # default
sudo ./install.sh --profile=enterprise
```

## After installation

A `collab` command is available for ongoing server maintenance:

```bash
collab status          # service health and versions
collab doctor          # full PASS/FAIL diagnostic
collab logs            # installation summary log
collab update --check  # list available system updates
collab update --apply  # apply system updates
```

## Testing on macOS

Use [Lima](https://lima-vm.io) to spin up a local Ubuntu VM:

```bash
limactl start --name ubuntu24 --vm-type=vz --memory 2 --cpus 2 \
  --mount-none template://ubuntu-lts
```

Then open a shell into the VM and run the installer as usual.

## Notes

- SSL configuration is a separate step, once a domain is available.
- Client application deployment is not part of this installer.
- Firewall and cloud-provider networking (security groups, VPC rules) are configured outside this project.
