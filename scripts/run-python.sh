#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/python-common.sh"

PYTHON_BIN=".venv/bin/python"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Python virtual environment not found at .venv." >&2
  echo "Run npm run setup before starting StemStudio." >&2
  exit 1
fi

if ! is_supported_python "$PYTHON_BIN"; then
  PYTHON_VERSION="$(python_version "$PYTHON_BIN")"
  echo "Python 3.10+ is required; found $PYTHON_VERSION at $PYTHON_BIN." >&2
  echo "Remove .venv and rerun npm run setup with a newer Python installed." >&2
  exit 1
fi

exec "$PYTHON_BIN" "$@"
