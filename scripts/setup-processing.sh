#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/python-common.sh"

VENV_PYTHON=".venv/bin/python"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "Python virtual environment not found at .venv." >&2
  echo "Run npm run setup first, then rerun npm run setup:processing." >&2
  exit 1
fi

if ! is_supported_python "$VENV_PYTHON"; then
  PYTHON_VERSION="$(python_version "$VENV_PYTHON")"
  echo "Python 3.10+ is required; found $PYTHON_VERSION at $VENV_PYTHON." >&2
  echo "Remove .venv and rerun npm run setup with a newer Python installed." >&2
  exit 1
fi

exec "$VENV_PYTHON" -m pip install -e '.[processing]'
