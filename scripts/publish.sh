#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "--- building collab-runtime ---"
pnpm run build

echo "--- staging collab-runtime files ---"
git add \
  .gitignore \
  package.json \
  scripts/publish.sh \
  agent/Cargo.toml \
  agent/Cargo.lock \
  agent/src/main.rs \
  install.sh \
  collab

if git diff --cached --quiet; then
  echo "--- nothing to commit ---"
else
  git commit -m "Add collab-sites runtime agent"
fi

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  echo "Cannot publish from detached HEAD" >&2
  exit 1
fi

echo "--- pushing ${branch} ---"
git push origin "$branch"
