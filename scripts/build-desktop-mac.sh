#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
LOCAL_NOTARIZATION_ENV="$PROJECT_ROOT/.env.notarization"

if [ -f "$LOCAL_NOTARIZATION_ENV" ]; then
  set -a
  . "$LOCAL_NOTARIZATION_ENV"
  set +a
fi

cd "$PROJECT_ROOT"

run_package_step() {
  local label="$1"
  shift

  if "$@"; then
    return
  fi

  echo >&2
  echo "ERROR macOS package build stopped while ${label}." >&2
  echo "      Fix the error above, then rerun npm run desktop:build:mac." >&2
  exit 1
}

build_mac_package() {
  local attempt=1
  local max_attempts=2
  local log_file

  while [ "$attempt" -le "$max_attempts" ]; do
    log_file="$(mktemp "${TMPDIR:-/tmp}/stemstudio-electron-builder.XXXXXX")"
    if npm run build:mac --workspace desktop 2>&1 | tee "$log_file"; then
      rm -f "$log_file"
      return
    fi

    if [ "$attempt" -lt "$max_attempts" ] &&
      grep -q "A timestamp was expected but was not found" "$log_file"; then
      echo "Retrying mac package build after Apple timestamp service returned an incomplete signature..."
      rm -f "$log_file"
      attempt=$((attempt + 1))
      continue
    fi

    rm -f "$log_file"
    return 1
  done
}

run_package_step "checking signing and notarization inputs" "$SCRIPT_DIR/require-macos-signing-env.sh"
run_package_step "building the bundled Python runtime" npm run desktop:runtime
run_package_step "building the frontend" npm run build
run_package_step "checking desktop package inputs" npm run desktop:doctor
run_package_step "building the signed Electron package" build_mac_package
run_package_step "verifying the signed macOS package" npm run desktop:verify:mac
