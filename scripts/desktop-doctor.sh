#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="${STEMSTUDIO_DESKTOP_RUNTIME_DIR:-$PROJECT_ROOT/desktop/runtime}"
FRONTEND_DIR="$PROJECT_ROOT/frontend/dist"
DESKTOP_DIR="$PROJECT_ROOT/desktop"
EXPECTED_ARCH="${STEMSTUDIO_DESKTOP_EXPECTED_ARCH:-$(uname -m)}"
DOCTOR_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stemstudio-desktop-doctor.XXXXXX")"
DOCTOR_STDOUT="$DOCTOR_DATA_DIR/stdout"
DOCTOR_STDERR="$DOCTOR_DATA_DIR/stderr"
DOCTOR_CHECK_TIMEOUT_SECONDS="${STEMSTUDIO_DOCTOR_CHECK_TIMEOUT_SECONDS:-90}"
FAILED=0
NODE_AVAILABLE=0
MACHO_TOOLS_AVAILABLE=0

case "$EXPECTED_ARCH" in
  arm64|x86_64) ;;
  *)
    echo "ERROR Unsupported desktop runtime architecture: $EXPECTED_ARCH" >&2
    exit 1
    ;;
esac

cleanup() {
  rm -rf "$DOCTOR_DATA_DIR"
}

trap cleanup EXIT

check_file() {
  local LABEL="$1"
  local PATH_TO_CHECK="$2"
  if [[ -f "$PATH_TO_CHECK" ]]; then
    echo "OK    $LABEL found"
  else
    echo "ERROR $LABEL missing at $PATH_TO_CHECK"
    FAILED=1
  fi
}

check_command() {
  local LABEL="$1"
  local COMMAND_NAME="$2"
  local INSTALL_HINT="$3"

  if command -v "$COMMAND_NAME" >/dev/null 2>&1; then
    echo "OK    $LABEL found"
    return 0
  fi

  echo "ERROR $LABEL missing: $COMMAND_NAME"
  echo "      $INSTALL_HINT"
  FAILED=1
  return 1
}

check_minimum_major_version() {
  local LABEL="$1"
  local COMMAND_NAME="$2"
  local MINIMUM_MAJOR="$3"
  local INSTALL_HINT="$4"
  local VERSION
  local MAJOR

  VERSION="$("$COMMAND_NAME" --version 2>/dev/null || true)"
  VERSION="${VERSION#v}"
  MAJOR="${VERSION%%.*}"
  if [[ ! "$MAJOR" =~ ^[0-9]+$ ]]; then
    echo "ERROR Could not read the installed $LABEL version."
    echo "      $INSTALL_HINT"
    FAILED=1
    return 1
  fi

  if [[ "$MAJOR" -ge "$MINIMUM_MAJOR" ]]; then
    echo "OK    $LABEL version $VERSION"
    return 0
  fi

  echo "ERROR $LABEL $MINIMUM_MAJOR or newer is required; found ${VERSION:-unknown}."
  echo "      $INSTALL_HINT"
  FAILED=1
  return 1
}

check_npm_version() {
  check_minimum_major_version "npm" "npm" 10 "Upgrade npm, then rerun npm run desktop:doctor."
}

check_node_syntax() {
  local LABEL="$1"
  local PATH_TO_CHECK="$2"

  if [[ "$NODE_AVAILABLE" -ne 1 ]]; then
    return
  fi

  if [[ ! -f "$PATH_TO_CHECK" ]]; then
    echo "ERROR $LABEL missing at $PATH_TO_CHECK"
    FAILED=1
    return
  fi

  if node --check "$PATH_TO_CHECK" >/dev/null 2>&1; then
    echo "OK    $LABEL syntax"
    return
  fi

  echo "ERROR $LABEL has a JavaScript syntax error"
  node --check "$PATH_TO_CHECK" 2>&1 | sed -n '1,8p'
  FAILED=1
}

check_executable() {
  local LABEL="$1"
  local PATH_TO_CHECK="$2"
  if [[ -x "$PATH_TO_CHECK" ]]; then
    echo "OK    $LABEL found"
  else
    echo "ERROR $LABEL missing or not executable at $PATH_TO_CHECK"
    FAILED=1
  fi
}

is_macho_file() {
  file "$1" | grep -q "Mach-O"
}

check_required_macho_arch() {
  local LABEL="$1"
  local PATH_TO_CHECK="$2"
  local ARCHS

  if [[ "$(uname -s)" != "Darwin" || "$MACHO_TOOLS_AVAILABLE" -ne 1 ]]; then
    return
  fi

  if [[ ! -f "$PATH_TO_CHECK" ]]; then
    echo "ERROR $LABEL missing at $PATH_TO_CHECK"
    FAILED=1
    return
  fi

  if ! is_macho_file "$PATH_TO_CHECK"; then
    echo "ERROR $LABEL is not a Mach-O binary at $PATH_TO_CHECK"
    FAILED=1
    return
  fi

  ARCHS="$(lipo -archs "$PATH_TO_CHECK" 2>/dev/null || true)"
  if [[ " $ARCHS " == *" $EXPECTED_ARCH "* ]]; then
    echo "OK    $LABEL architecture includes $EXPECTED_ARCH"
  else
    echo "ERROR $LABEL has architectures: ${ARCHS:-unknown}; expected $EXPECTED_ARCH"
    FAILED=1
  fi
}

check_runtime_macho_architectures() {
  local ROOT_DIR="$1"
  local PATH_TO_CHECK
  local ARCHS
  local RELATIVE_PATH
  local CHECKED=0
  local ARCH_FAILED=0

  if [[ "$(uname -s)" != "Darwin" || "$MACHO_TOOLS_AVAILABLE" -ne 1 || ! -d "$ROOT_DIR" ]]; then
    return
  fi

  while IFS= read -r -d '' PATH_TO_CHECK; do
    if is_macho_file "$PATH_TO_CHECK"; then
      CHECKED=$((CHECKED + 1))
      ARCHS="$(lipo -archs "$PATH_TO_CHECK" 2>/dev/null || true)"
      if [[ " $ARCHS " != *" $EXPECTED_ARCH "* ]]; then
        RELATIVE_PATH="${PATH_TO_CHECK#"$ROOT_DIR"/}"
        echo "ERROR Runtime binary $RELATIVE_PATH has architectures: ${ARCHS:-unknown}; expected $EXPECTED_ARCH"
        ARCH_FAILED=1
      fi
    fi
  done < <(find "$ROOT_DIR" -type f \( -perm -111 -o -name '*.so' -o -name '*.dylib' -o -name '*.node' \) -print0)

  if [[ "$CHECKED" -eq 0 ]]; then
    echo "ERROR Runtime architecture check found no Mach-O binaries in $ROOT_DIR"
    FAILED=1
  elif [[ "$ARCH_FAILED" -eq 0 ]]; then
    echo "OK    runtime Mach-O architectures include $EXPECTED_ARCH ($CHECKED files)"
  else
    FAILED=1
  fi
}

run_check() {
  local LABEL="$1"
  local TIMEOUT_MARKER="$DOCTOR_DATA_DIR/timeout"
  local PID
  local WATCHDOG_PID
  local STATUS
  shift

  rm -f "$TIMEOUT_MARKER"
  "$@" >"$DOCTOR_STDOUT" 2>"$DOCTOR_STDERR" &
  PID=$!
  (
    sleep "$DOCTOR_CHECK_TIMEOUT_SECONDS"
    if kill -0 "$PID" 2>/dev/null; then
      touch "$TIMEOUT_MARKER"
      kill -TERM "$PID" 2>/dev/null || true
      sleep 2
      kill -KILL "$PID" 2>/dev/null || true
    fi
  ) &
  WATCHDOG_PID=$!

  if wait "$PID"; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    echo "OK    $LABEL"
  else
    STATUS=$?
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    if [[ -f "$TIMEOUT_MARKER" ]]; then
      echo "ERROR $LABEL timed out after ${DOCTOR_CHECK_TIMEOUT_SECONDS}s"
    else
      echo "ERROR $LABEL failed with exit code $STATUS"
    fi
    print_check_output "stderr" "$DOCTOR_STDERR"
    print_check_output "stdout" "$DOCTOR_STDOUT"
    FAILED=1
  fi
}

print_check_output() {
  local LABEL="$1"
  local OUTPUT_PATH="$2"

  if [[ ! -s "$OUTPUT_PATH" ]]; then
    return
  fi

  echo "      ${LABEL}:"
  sed -n '1,8p' "$OUTPUT_PATH" | sed 's/^/      /'
}

API_BIN="$RUNTIME_DIR/stemstudio-api/stemstudio-api"
WORKER_BIN="$RUNTIME_DIR/stemstudio-worker/stemstudio-worker"
FFMPEG_BIN="$RUNTIME_DIR/bin/ffmpeg"
FFPROBE_BIN="$RUNTIME_DIR/bin/ffprobe"
SEPARATOR_BIN="$RUNTIME_DIR/bin/audio-separator"
SEPARATOR_EXECUTABLE="$RUNTIME_DIR/audio-separator/audio-separator"
YT_DLP_BIN="$RUNTIME_DIR/bin/yt-dlp"
YT_DLP_EXECUTABLE="$RUNTIME_DIR/yt-dlp/yt-dlp"

echo "Checking StemStudio desktop package inputs..."
echo

if check_command "Node.js" "node" "Install Node.js 20 or newer, then rerun npm run desktop:doctor."; then
  if check_minimum_major_version "Node.js" "node" 20 "Install a current Node.js release, then rerun npm run desktop:doctor."; then
    NODE_AVAILABLE=1
  fi
fi
if check_command "npm" "npm" "Install npm 10 or newer with Node.js, then rerun npm run desktop:doctor."; then
  check_npm_version || true
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  FILE_AVAILABLE=0
  LIPO_AVAILABLE=0
  if check_command "file command" "file" "Install the Xcode Command Line Tools with: xcode-select --install"; then
    FILE_AVAILABLE=1
  fi
  if check_command "lipo command" "lipo" "Install the Xcode Command Line Tools with: xcode-select --install"; then
    LIPO_AVAILABLE=1
  fi
  if [[ "$FILE_AVAILABLE" -eq 1 && "$LIPO_AVAILABLE" -eq 1 ]]; then
    MACHO_TOOLS_AVAILABLE=1
  fi
fi

echo

check_file "Electron main process" "$DESKTOP_DIR/src/main.js"
check_file "Electron preload" "$DESKTOP_DIR/src/preload.cjs"
check_file "Electron package manifest" "$DESKTOP_DIR/package.json"
check_file "macOS entitlements" "$DESKTOP_DIR/build/entitlements.mac.plist"
check_file "macOS app icon" "$DESKTOP_DIR/build/icon.icns"
check_file "frontend build" "$FRONTEND_DIR/index.html"
check_node_syntax "Electron main process" "$DESKTOP_DIR/src/main.js"
check_node_syntax "Electron preload" "$DESKTOP_DIR/src/preload.cjs"
check_node_syntax "Electron builder config" "$DESKTOP_DIR/electron-builder.config.cjs"
check_executable "API runtime" "$API_BIN"
check_executable "worker runtime" "$WORKER_BIN"
check_executable "ffmpeg" "$FFMPEG_BIN"
check_executable "ffprobe" "$FFPROBE_BIN"
check_executable "audio-separator launcher" "$SEPARATOR_BIN"
check_executable "audio-separator runtime" "$SEPARATOR_EXECUTABLE"
check_executable "yt-dlp launcher" "$YT_DLP_BIN"
check_executable "yt-dlp runtime" "$YT_DLP_EXECUTABLE"

check_required_macho_arch "API runtime" "$API_BIN"
check_required_macho_arch "worker runtime" "$WORKER_BIN"
check_required_macho_arch "ffmpeg" "$FFMPEG_BIN"
check_required_macho_arch "ffprobe" "$FFPROBE_BIN"
check_required_macho_arch "audio-separator runtime" "$SEPARATOR_EXECUTABLE"
check_required_macho_arch "yt-dlp runtime" "$YT_DLP_EXECUTABLE"
check_runtime_macho_architectures "$RUNTIME_DIR"

if [[ "$FAILED" -eq 0 ]]; then
  run_check "API health check" env \
    STEMSTUDIO_DESKTOP_RESOURCES_DIR="$RUNTIME_DIR" \
    STEMSTUDIO_DESKTOP_USER_DATA_DIR="$DOCTOR_DATA_DIR" \
    "$API_BIN" --health-check
  run_check "worker health check" env \
    STEMSTUDIO_DESKTOP_RESOURCES_DIR="$RUNTIME_DIR" \
    STEMSTUDIO_DESKTOP_USER_DATA_DIR="$DOCTOR_DATA_DIR" \
    "$WORKER_BIN" --health-check
  run_check "ffmpeg version" "$FFMPEG_BIN" -version
  run_check "ffprobe version" "$FFPROBE_BIN" -version
  run_check "audio-separator version" "$SEPARATOR_BIN" --version
  run_check "yt-dlp version" "$YT_DLP_BIN" --version
fi

if [[ -d "$RUNTIME_DIR" ]] && find "$RUNTIME_DIR" -path '*/cache/models/*' -print -quit | grep -q .; then
  echo "ERROR Desktop runtime contains model cache files. Keep downloaded separation models out of the app bundle."
  FAILED=1
fi

echo

if [[ "$FAILED" -ne 0 ]]; then
  echo "Desktop doctor found package input problems."
  exit 1
fi

echo "Desktop doctor found no package input problems."
