#!/bin/bash
# scripts/00a-etc-on-data.sh
# Make ETC_DIR a symlink to DATA_ETC (defaults: /etc/collab -> /data/etc).
# Idempotent. Never prints file contents. Never deletes the previous directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../core/logger.sh
source "${REPO_ROOT}/core/logger.sh"
# shellcheck source=../core/utils.sh
source "${REPO_ROOT}/core/utils.sh"

ETC_DIR="${ETC_DIR:-/etc/collab}"
DATA_ETC="${DATA_ETC:-/data/etc}"

if [[ "$DATA_ETC" == "/data/etc" ]]; then
  if ! mountpoint -q /data; then
    echo "/data is not mounted; refusing to place ${ETC_DIR} on the system disk" >&2
    exit 1
  fi
fi

if [[ -e "$DATA_ETC" || -L "$DATA_ETC" ]]; then
  if [[ -L "$DATA_ETC" || ! -d "$DATA_ETC" ]]; then
    echo "DATA_ETC is not a directory: ${DATA_ETC}" >&2
    exit 1
  fi
else
  mkdir -m 0755 "$DATA_ETC"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown root:root "$DATA_ETC"
  fi
fi

if [[ -L "$ETC_DIR" ]]; then
  target="$(readlink "$ETC_DIR")"
  if [[ "$target" == "$DATA_ETC" ]]; then
    exit 0
  fi
  if [[ -d "$DATA_ETC" ]] && command -v realpath >/dev/null 2>&1 \
    && [[ "$(realpath "$ETC_DIR")" == "$(realpath "$DATA_ETC")" ]]; then
    exit 0
  fi
  echo "${ETC_DIR} is a symlink to ${target}, expected ${DATA_ETC}" >&2
  exit 1
fi

if [[ -d "$ETC_DIR" ]]; then
  while IFS= read -r -d '' src; do
    rel="${src#"${ETC_DIR}/"}"
    dest="${DATA_ETC}/${rel}"
    if [[ -e "$dest" || -L "$dest" ]]; then
      if [[ -f "$src" && ! -L "$src" && -f "$dest" && ! -L "$dest" ]]; then
        if ! cmp -s "$src" "$dest"; then
          echo "content conflict: ${dest}" >&2
          exit 1
        fi
      elif [[ -d "$src" && ! -L "$src" && -d "$dest" && ! -L "$dest" ]]; then
        :
      else
        echo "content conflict: ${dest}" >&2
        exit 1
      fi
    fi
  done < <(find "$ETC_DIR" -mindepth 1 -print0)

  # Copy only missing paths so an existing DATA_ETC keeps its owner, mode,
  # and files that were never in ETC_DIR (for example appconfig.json).
  copy_missing() {
    local src="$1" dest="$2" child name child_dest
    while IFS= read -r -d '' child; do
      name="$(basename "$child")"
      child_dest="${dest}/${name}"
      if [[ ! -e "$child_dest" && ! -L "$child_dest" ]]; then
        cp -a "$child" "$child_dest"
      elif [[ -d "$child" && ! -L "$child" && -d "$child_dest" && ! -L "$child_dest" ]]; then
        copy_missing "$child" "$child_dest"
      fi
    done < <(find "$src" -mindepth 1 -maxdepth 1 -print0)
  }
  copy_missing "$ETC_DIR" "$DATA_ETC"
  stamp="$(date +%Y%m%d%H%M%S)"
  mv "$ETC_DIR" "${ETC_DIR}.pre-data-${stamp}"
  ln -s "$DATA_ETC" "$ETC_DIR"
  exit 0
fi

if [[ -e "$ETC_DIR" ]]; then
  echo "${ETC_DIR} exists and is not a directory or symlink" >&2
  exit 1
fi

ln -s "$DATA_ETC" "$ETC_DIR"
