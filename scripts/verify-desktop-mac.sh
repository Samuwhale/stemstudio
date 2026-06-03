#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
EXPECTED_ARCH="${STEMSTUDIO_DESKTOP_EXPECTED_ARCH:-$(uname -m)}"
VERIFY_DIR=""
VERIFY_DATA_DIR=""
VERIFY_CHECK_TIMEOUT_SECONDS="${STEMSTUDIO_VERIFY_CHECK_TIMEOUT_SECONDS:-90}"
FAILED=0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR macOS package verification must run on macOS." >&2
  exit 1
fi

case "$EXPECTED_ARCH" in
  arm64|x86_64) ;;
  *)
    echo "ERROR Unsupported desktop package architecture: $EXPECTED_ARCH" >&2
    exit 1
    ;;
esac

default_app_path() {
  case "$EXPECTED_ARCH" in
    arm64) printf '%s\n' "$PROJECT_ROOT/release/mac-arm64/StemStudio.app" ;;
    x86_64) printf '%s\n' "$PROJECT_ROOT/release/mac/StemStudio.app" ;;
  esac
}

check_command() {
  local LABEL="$1"
  local COMMAND_NAME="$2"
  local INSTALL_HINT="$3"

  if command -v "$COMMAND_NAME" >/dev/null 2>&1; then
    echo "OK    $LABEL found"
    return
  fi

  echo "ERROR $LABEL is required but was not found." >&2
  echo "      $INSTALL_HINT" >&2
  exit 1
}

APP_PATH="${1:-${STEMSTUDIO_DESKTOP_APP_PATH:-$(default_app_path)}}"

case "$APP_PATH" in
  /*) ;;
  *) APP_PATH="$PROJECT_ROOT/$APP_PATH" ;;
esac

check_app() {
  if [[ -d "$APP_PATH" ]]; then
    echo "OK    app bundle found"
    return
  fi

  echo "ERROR app bundle missing at $APP_PATH"
  exit 1
}

run_check() {
  local LABEL="$1"
  local TIMEOUT_MARKER="$VERIFY_DIR/timeout"
  local PID
  local WATCHDOG_PID
  local STATUS
  shift

  rm -f "$TIMEOUT_MARKER"
  "$@" >"$VERIFY_DIR/stdout" 2>"$VERIFY_DIR/stderr" &
  PID=$!
  (
    sleep "$VERIFY_CHECK_TIMEOUT_SECONDS"
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
      echo "ERROR $LABEL timed out after ${VERIFY_CHECK_TIMEOUT_SECONDS}s"
    else
      echo "ERROR $LABEL failed with exit code $STATUS"
    fi
    print_check_output "stderr" "$VERIFY_DIR/stderr"
    print_check_output "stdout" "$VERIFY_DIR/stdout"
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
  sed -n '1,12p' "$OUTPUT_PATH" | sed 's/^/      /'
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

is_macho_file() {
  file "$1" | grep -q "Mach-O"
}

check_required_macho_arch() {
  local LABEL="$1"
  local PATH_TO_CHECK="$2"
  local ARCHS

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

check_app_macho_architectures() {
  local ROOT_DIR="$1"
  local PATH_TO_CHECK
  local ARCHS
  local RELATIVE_PATH
  local CHECKED=0
  local ARCH_FAILED=0

  while IFS= read -r -d '' PATH_TO_CHECK; do
    if is_macho_file "$PATH_TO_CHECK"; then
      CHECKED=$((CHECKED + 1))
      ARCHS="$(lipo -archs "$PATH_TO_CHECK" 2>/dev/null || true)"
      if [[ " $ARCHS " != *" $EXPECTED_ARCH "* ]]; then
        RELATIVE_PATH="${PATH_TO_CHECK#"$ROOT_DIR"/}"
        echo "ERROR App binary $RELATIVE_PATH has architectures: ${ARCHS:-unknown}; expected $EXPECTED_ARCH"
        ARCH_FAILED=1
      fi
    fi
  done < <(find "$ROOT_DIR" -type f \( -perm -111 -o -name '*.so' -o -name '*.dylib' -o -name '*.node' \) -print0)

  if [[ "$CHECKED" -eq 0 ]]; then
    echo "ERROR App architecture check found no Mach-O binaries in $ROOT_DIR"
    FAILED=1
  elif [[ "$ARCH_FAILED" -eq 0 ]]; then
    echo "OK    app Mach-O architectures include $EXPECTED_ARCH ($CHECKED files)"
  else
    FAILED=1
  fi
}

cleanup() {
  if [[ -n "$VERIFY_DIR" ]]; then
    rm -rf "$VERIFY_DIR"
  fi
  if [[ -n "$VERIFY_DATA_DIR" ]]; then
    rm -rf "$VERIFY_DATA_DIR"
  fi
}

trap cleanup EXIT

VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stemstudio-verify.XXXXXX")"
VERIFY_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stemstudio-verify-data.XXXXXX")"

RUNTIME_DIR="$APP_PATH/Contents/Resources/runtime"
RESOURCES_DIR="$APP_PATH/Contents/Resources"

echo "Checking macOS package verification prerequisites..."
check_command "file command" "file" "Install the Xcode Command Line Tools with: xcode-select --install"
check_command "lipo command" "lipo" "Install the Xcode Command Line Tools with: xcode-select --install"
check_command "codesign" "codesign" "Install the Xcode Command Line Tools with: xcode-select --install"
check_command "xcrun" "xcrun" "Install Xcode or the Xcode Command Line Tools, then rerun npm run desktop:verify:mac."
check_command "spctl" "spctl" "Install the macOS system policy tools, then rerun npm run desktop:verify:mac."
echo

check_app
check_file "packaged frontend" "$RESOURCES_DIR/frontend/index.html"
check_file "packaged Electron app archive" "$RESOURCES_DIR/app.asar"
check_executable "StemStudio app executable" "$APP_PATH/Contents/MacOS/StemStudio"
check_executable "API runtime" "$RUNTIME_DIR/stemstudio-api/stemstudio-api"
check_executable "worker runtime" "$RUNTIME_DIR/stemstudio-worker/stemstudio-worker"
check_executable "ffmpeg" "$RUNTIME_DIR/bin/ffmpeg"
check_executable "ffprobe" "$RUNTIME_DIR/bin/ffprobe"
check_executable "audio-separator launcher" "$RUNTIME_DIR/bin/audio-separator"
check_executable "audio-separator runtime" "$RUNTIME_DIR/audio-separator/audio-separator"
check_executable "yt-dlp launcher" "$RUNTIME_DIR/bin/yt-dlp"
check_executable "yt-dlp runtime" "$RUNTIME_DIR/yt-dlp/yt-dlp"

run_check "codesign verification" codesign --verify --deep --strict --verbose=2 "$APP_PATH"
run_check "stapler validation" xcrun stapler validate "$APP_PATH"
run_check "Gatekeeper assessment" spctl --assess --type execute --verbose=4 "$APP_PATH"

check_required_macho_arch "StemStudio app executable" "$APP_PATH/Contents/MacOS/StemStudio"
check_required_macho_arch "API runtime" "$RUNTIME_DIR/stemstudio-api/stemstudio-api"
check_required_macho_arch "worker runtime" "$RUNTIME_DIR/stemstudio-worker/stemstudio-worker"
check_required_macho_arch "ffmpeg" "$RUNTIME_DIR/bin/ffmpeg"
check_required_macho_arch "ffprobe" "$RUNTIME_DIR/bin/ffprobe"
check_required_macho_arch "audio-separator runtime" "$RUNTIME_DIR/audio-separator/audio-separator"
check_required_macho_arch "yt-dlp runtime" "$RUNTIME_DIR/yt-dlp/yt-dlp"
check_app_macho_architectures "$APP_PATH"

if [[ -d "$RUNTIME_DIR" && -n "$(find "$RUNTIME_DIR" -path '*/cache/models/*' -print -quit)" ]]; then
  echo "ERROR Packaged runtime contains model cache files. Keep downloaded separation models out of the app bundle."
  FAILED=1
fi

if [[ "$FAILED" -eq 0 ]]; then
  run_check "packaged API health check" env \
    STEMSTUDIO_DESKTOP_RESOURCES_DIR="$RUNTIME_DIR" \
    STEMSTUDIO_DESKTOP_USER_DATA_DIR="$VERIFY_DATA_DIR" \
    "$RUNTIME_DIR/stemstudio-api/stemstudio-api" --health-check
  run_check "packaged worker health check" env \
    STEMSTUDIO_DESKTOP_RESOURCES_DIR="$RUNTIME_DIR" \
    STEMSTUDIO_DESKTOP_USER_DATA_DIR="$VERIFY_DATA_DIR" \
    "$RUNTIME_DIR/stemstudio-worker/stemstudio-worker" --health-check
  run_check "packaged ffmpeg version" "$RUNTIME_DIR/bin/ffmpeg" -version
  run_check "packaged ffprobe version" "$RUNTIME_DIR/bin/ffprobe" -version
  run_check "packaged audio-separator version" "$RUNTIME_DIR/bin/audio-separator" --version
  run_check "packaged yt-dlp version" "$RUNTIME_DIR/bin/yt-dlp" --version
fi

echo

if [[ "$FAILED" -ne 0 ]]; then
  echo "Desktop mac package verification failed."
  exit 1
fi

echo "Desktop mac package verification passed."
