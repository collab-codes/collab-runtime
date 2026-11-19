#!/bin/bash
# scripts/lib/mls-tsrs.sh — sourced by 10-mls-runtime.sh (shared tree) and 12-mls-project.sh (tree per project).
# After the dependencies are installed: record `tsrs -v`. A missing or dead binary does not fail the step;
# the mls-base build falls back to tsc (scripts/tsCompiler.mjs, rt256).
note_tsrs() {
  local root="$1"
  local version=""
  if version="$("${root}/node_modules/.bin/tsrs" -v 2>&1)"; then
    log_info "tsrs ${version}"
  else
    log_warn "tsrs did not answer -v in ${root} — the build will use tsc"
  fi
}
