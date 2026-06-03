#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/python-common.sh"

require_command() {
  local label="$1"
  local command_name="$2"
  local install_hint="$3"

  if command -v "$command_name" >/dev/null 2>&1; then
    echo "OK    $label found"
    return
  fi

  echo "ERROR $label is required but was not found." >&2
  echo "      $install_hint" >&2
  exit 1
}

require_minimum_major_version() {
  local label="$1"
  local command_name="$2"
  local minimum_major="$3"
  local install_hint="$4"
  local version
  local major

  version="$("$command_name" --version 2>/dev/null || true)"
  version="${version#v}"
  major="${version%%.*}"
  if [[ ! "$major" =~ ^[0-9]+$ ]]; then
    echo "ERROR Could not read the installed $label version." >&2
    echo "      $install_hint" >&2
    exit 1
  fi

  if [[ "$major" -ge "$minimum_major" ]]; then
    echo "OK    $label version $version"
    return
  fi

  echo "ERROR $label $minimum_major or newer is required; found ${version:-unknown}." >&2
  echo "      $install_hint" >&2
  exit 1
}

require_node_version() {
  require_minimum_major_version \
    "Node.js" \
    "node" \
    20 \
    "Install a current Node.js release, then rerun npm run setup:local."
}

require_npm_version() {
  require_minimum_major_version \
    "npm" \
    "npm" \
    10 \
    "Upgrade npm, then rerun npm run setup:local."
}

require_python() {
  local python_bin

  if python_bin="$(find_python)"; then
    echo "OK    Python $(python_version "$python_bin") found at $python_bin"
    return
  fi

  echo "ERROR Python 3.11 or newer is required but was not found." >&2
  echo "      Install Python with Homebrew: brew install python" >&2
  echo "      Then rerun npm run setup:local." >&2
  exit 1
}

run_setup_step() {
  local label="$1"
  shift

  if "$@"; then
    return
  fi

  echo >&2
  echo "ERROR Setup stopped while ${label}." >&2
  echo "      Fix the error above, then rerun npm run setup:local." >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR StemStudio desktop setup is macOS-only for now." >&2
  exit 1
fi

echo "Checking local prerequisites..."
require_command "Node.js" "node" "Install Node.js 20 or newer from https://nodejs.org/ or Homebrew."
require_command "npm" "npm" "Install npm 10 or newer with Node.js."
require_command "file command" "file" "Install the Xcode Command Line Tools with: xcode-select --install"
require_command "lipo command" "lipo" "Install the Xcode Command Line Tools with: xcode-select --install"
require_node_version
require_npm_version
require_python

cd "$PROJECT_ROOT"

echo
echo "Setting up StemStudio for local desktop use..."
echo

echo "Installing JavaScript dependencies..."
run_setup_step "installing JavaScript dependencies" npm install

echo
echo "Building bundled Python runtime..."
run_setup_step "building the bundled Python runtime" npm run desktop:runtime

echo
echo "Building frontend..."
run_setup_step "building the frontend" npm run build

echo
echo "Checking desktop package inputs..."
run_setup_step "checking desktop package inputs" npm run desktop:doctor

echo
echo "StemStudio local setup is ready."
echo "Run npm run desktop:run to open the local desktop app."
