#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/python-common.sh"

PYTHON_BIN=".venv/bin/python"

cd "$PROJECT_ROOT"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Python virtual environment not found at .venv." >&2
  echo "Run npm run desktop:runtime to create the bundled runtime." >&2
  exit 1
fi

if ! is_supported_python "$PYTHON_BIN"; then
  PYTHON_VERSION="$(python_version "$PYTHON_BIN")"
  echo "Python 3.11+ is required; found $PYTHON_VERSION at $PYTHON_BIN." >&2
  echo "Remove .venv and rerun npm run desktop:runtime with Python 3.11 or newer installed." >&2
  exit 1
fi

exec "$PYTHON_BIN" "$@"
