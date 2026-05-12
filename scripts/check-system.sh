#!/usr/bin/env sh

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/python-common.sh"

FAILED=0

major_version() {
  printf '%s\n' "$1" | sed 's/^[^0-9]*//' | cut -d. -f1
}

check_minimum_major() {
  LABEL="$1"
  COMMAND="$2"
  MINIMUM="$3"
  INSTALL_HINT="$4"

  if ! command -v "$COMMAND" >/dev/null 2>&1; then
    echo "ERROR $LABEL was not found."
    echo "      $INSTALL_HINT"
    FAILED=1
    return
  fi

  VERSION="$("$COMMAND" --version 2>/dev/null | head -n 1)"
  MAJOR="$(major_version "$VERSION")"

  case "$MAJOR" in
    ''|*[!0-9]*)
      echo "ERROR Could not read the $LABEL version from: $VERSION"
      FAILED=1
      ;;
    *)
      if [ "$MAJOR" -lt "$MINIMUM" ]; then
        echo "ERROR $LABEL $VERSION is installed, but StemStudio needs $LABEL $MINIMUM or newer."
        echo "      $INSTALL_HINT"
        FAILED=1
      else
        echo "OK    $LABEL $VERSION"
      fi
      ;;
  esac
}

check_binary() {
  LABEL="$1"
  COMMAND="$2"
  REQUIRED="$3"
  INSTALL_HINT="$4"

  if command -v "$COMMAND" >/dev/null 2>&1; then
    echo "OK    $LABEL found at $(command -v "$COMMAND")"
    return
  fi

  if [ "$REQUIRED" = "required" ]; then
    echo "ERROR $LABEL was not found."
    echo "      $INSTALL_HINT"
    FAILED=1
  else
    echo "WARN  $LABEL was not found."
    echo "      $INSTALL_HINT"
  fi
}

echo "Checking StemStudio system requirements..."
echo

check_minimum_major "Node.js" "node" 20 "Install Node.js 20 or newer. With nvm: nvm install 20 && nvm use 20"
check_minimum_major "npm" "npm" 10 "Install npm 10 or newer. It is included with current Node.js releases."

if PYTHON_BIN="$(find_python)"; then
  echo "OK    Python $(python_version "$PYTHON_BIN") found at $PYTHON_BIN"
else
  echo "ERROR Python 3.10 or newer was not found."
  echo "      Install Python 3.10 or newer, then rerun npm run setup."
  FAILED=1
fi

check_binary "ffmpeg" "ffmpeg" "required" "macOS: brew install ffmpeg. Debian/Ubuntu: sudo apt-get install ffmpeg."
check_binary "ffprobe" "ffprobe" "required" "ffprobe is installed with ffmpeg."
check_binary "yt-dlp" "yt-dlp" "optional" "Install it only if you want YouTube imports. macOS: brew install yt-dlp. Universal: pipx install yt-dlp."

if [ -x ".venv/bin/python" ]; then
  VENV_VERSION="$(.venv/bin/python -c 'import sys; print(".".join(str(part) for part in sys.version_info[:3]))')"
  echo "OK    Project virtual environment uses Python $VENV_VERSION"

  if .venv/bin/python -c 'import audio_separator' >/dev/null 2>&1; then
    echo "OK    audio-separator is installed for real stem separation"
  else
    echo "WARN  audio-separator is not installed."
    echo "      Run npm run setup:processing if you want real stem separation."
  fi
else
  echo "WARN  Project virtual environment does not exist yet."
  echo "      Run npm run setup to create it."
fi

echo

if [ "$FAILED" -ne 0 ]; then
  echo "System check failed. Fix the ERROR items above, then rerun npm run check:system."
  exit 1
fi

echo "System check passed."
