#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/python-common.sh"

PYTHON_BIN="${PYTHON_BIN:-}"

if [ -n "$PYTHON_BIN" ]; then
  :
elif [ -x ".venv/bin/python" ]; then
  PYTHON_BIN=".venv/bin/python"
elif ! PYTHON_BIN="$(find_python)"; then
  echo "Python 3.10+ is required. Create .venv or install a newer Python interpreter." >&2
  exit 1
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "Python 3.10+ is required. Create .venv or install a newer Python interpreter." >&2
  exit 1
fi

if ! is_supported_python "$PYTHON_BIN"; then
  PYTHON_VERSION="$(python_version "$PYTHON_BIN")"
  echo "Python 3.10+ is required; found $PYTHON_VERSION at $PYTHON_BIN. Create .venv or update PATH to a newer interpreter." >&2
  exit 1
fi

exec "$PYTHON_BIN" "$@"
