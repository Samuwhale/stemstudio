#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/python-common.sh"

PYTHON_EXTRA="${STEMSTUDIO_PYTHON_EXTRA:-}"

run_python_setup_step() {
  label="$1"
  shift

  if "$@"; then
    return
  fi

  echo >&2
  echo "ERROR Python setup stopped while ${label}." >&2
  echo "      Fix the error above, then rerun npm run desktop:runtime." >&2
  exit 1
}

ensure_venv_pip() {
  if .venv/bin/python -m pip --version >/dev/null 2>&1; then
    return
  fi

  echo "Installing pip into Python virtual environment..."
  if .venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 &&
    .venv/bin/python -m pip --version >/dev/null 2>&1; then
    return
  fi

  echo "ERROR Project virtual environment does not have a working pip." >&2
  echo "      Remove .venv and rerun npm run desktop:runtime." >&2
  echo "      If this repeats, reinstall Python with venv/ensurepip support." >&2
  exit 1
}

if PYTHON_BIN="$(find_python)"; then
  echo "OK    Python $(python_version "$PYTHON_BIN") found at $PYTHON_BIN"
else
  echo "ERROR Python 3.11 or newer was not found." >&2
  echo "      macOS: brew install python" >&2
  echo "      Debian/Ubuntu: sudo apt-get install python3 python3-venv" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [ ! -x ".venv/bin/python" ]; then
  echo "Creating Python virtual environment..."
  if ! "$PYTHON_BIN" -m venv .venv; then
    echo "ERROR Could not create the Python virtual environment at .venv." >&2
    echo "      Reinstall Python with venv support, then rerun npm run desktop:runtime." >&2
    echo "      macOS: brew install python" >&2
    echo "      Debian/Ubuntu: sudo apt-get install python3 python3-venv" >&2
    exit 1
  fi
elif ! is_supported_python ".venv/bin/python"; then
  VENV_VERSION="$(python_version ".venv/bin/python")"
  echo "ERROR Project virtual environment uses Python $VENV_VERSION, but StemStudio needs Python 3.11 or newer." >&2
  echo "      Remove .venv and rerun npm run desktop:runtime." >&2
  exit 1
fi

ensure_venv_pip

INSTALL_TARGET="."
if [ -n "$PYTHON_EXTRA" ]; then
  INSTALL_TARGET=".[${PYTHON_EXTRA}]"
fi

echo "Installing Python dependencies (${INSTALL_TARGET})..."
run_python_setup_step "upgrading pip" .venv/bin/python -m pip install --upgrade pip
run_python_setup_step "installing Python dependencies (${INSTALL_TARGET})" .venv/bin/python -m pip install -e "$INSTALL_TARGET"
