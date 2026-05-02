#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/python-common.sh"

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if ! PYTHON_BIN="$(find_python)"; then
    echo "Python 3.10+ is required. Install Python 3.10 or newer, then rerun npm run setup:python." >&2
    exit 1
  fi
fi

if ! is_supported_python "$PYTHON_BIN"; then
  PYTHON_VERSION="$(python_version "$PYTHON_BIN")"
  echo "Python 3.10+ is required; found $PYTHON_VERSION at $PYTHON_BIN." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
