#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
FINAL_RUNTIME_DIR="${STEMSTUDIO_DESKTOP_RUNTIME_DIR:-$PROJECT_ROOT/desktop/runtime}"
PYTHON_BIN="$PROJECT_ROOT/.venv/bin/python"
EXPECTED_ARCH="${STEMSTUDIO_DESKTOP_EXPECTED_ARCH:-$(uname -m)}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR Desktop runtime packaging is macOS-only for now." >&2
  exit 1
fi

case "$EXPECTED_ARCH" in
  arm64|x86_64) ;;
  *)
    echo "ERROR Unsupported desktop runtime architecture: $EXPECTED_ARCH" >&2
    exit 1
    ;;
esac

require_command() {
  local name="$1"
  local install_hint="$2"

  if command -v "$name" >/dev/null 2>&1; then
    return
  fi

  echo "ERROR $name is required but was not found." >&2
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
    return
  fi

  echo "ERROR $label $minimum_major or newer is required; found ${version:-unknown}." >&2
  echo "      $install_hint" >&2
  exit 1
}

resolve_node_package_path() {
  local label="$1"
  local script="$2"
  local resolved_path

  if resolved_path="$(node -e "$script" 2>/dev/null)" && [[ -n "$resolved_path" ]]; then
    printf '%s\n' "$resolved_path"
    return
  fi

  echo "ERROR Could not resolve the $label package." >&2
  echo "      Run npm install, then rerun npm run desktop:runtime." >&2
  exit 1
}

run_runtime_build_step() {
  local label="$1"
  shift

  if "$@"; then
    return
  fi

  echo >&2
  echo "ERROR Desktop runtime build stopped while ${label}." >&2
  echo "      Fix the error above, then rerun npm run desktop:runtime." >&2
  exit 1
}

cd "$PROJECT_ROOT"

require_command "node" "Install Node.js 20 or newer, then rerun npm run desktop:runtime."
require_minimum_major_version "Node.js" "node" 20 "Install a current Node.js release, then rerun npm run desktop:runtime."
require_command "file" "Install the Xcode Command Line Tools with: xcode-select --install"
require_command "lipo" "Install the Xcode Command Line Tools with: xcode-select --install"
FFMPEG_BIN="$(resolve_node_package_path "ffmpeg-static" 'const binary = require("ffmpeg-static"); if (!binary) process.exit(1); console.log(binary)')"
FFPROBE_BIN="$(resolve_node_package_path "@ffprobe-installer/ffprobe" 'const ffprobe = require("@ffprobe-installer/ffprobe"); if (!ffprobe || !ffprobe.path) process.exit(1); console.log(ffprobe.path)')"

RUNTIME_PARENT="$(dirname -- "$FINAL_RUNTIME_DIR")"
mkdir -p "$RUNTIME_PARENT"
RUNTIME_PARENT="$(CDPATH= cd -- "$RUNTIME_PARENT" && pwd)"
RUNTIME_NAME="$(basename -- "$FINAL_RUNTIME_DIR")"
RUNTIME_DIR="$RUNTIME_PARENT/$RUNTIME_NAME"
STAGING_ROOT="$(mktemp -d "$RUNTIME_PARENT/.${RUNTIME_NAME}.build.XXXXXX")"
STAGING_RUNTIME_DIR="$STAGING_ROOT/runtime"
BIN_DIR="$STAGING_RUNTIME_DIR/bin"
BUILD_DIR="$STAGING_ROOT/pyinstaller-build"
SPEC_DIR="$STAGING_ROOT/pyinstaller-spec"
VALIDATION_DATA_DIR="$STAGING_ROOT/validation-data"
VALIDATION_STDOUT="$STAGING_ROOT/validation-stdout"
VALIDATION_STDERR="$STAGING_ROOT/validation-stderr"
RUNTIME_CHECK_TIMEOUT_SECONDS="${STEMSTUDIO_RUNTIME_CHECK_TIMEOUT_SECONDS:-90}"
BACKUP_RUNTIME_DIR="$RUNTIME_PARENT/.${RUNTIME_NAME}.previous.$$"
SWAP_IN_PROGRESS=0
SWAP_COMPLETE=0

cleanup() {
  local status=$?
  trap - EXIT
  set +e

  if [[ "$SWAP_IN_PROGRESS" -eq 1 && "$SWAP_COMPLETE" -eq 0 ]]; then
    rm -rf "$RUNTIME_DIR"
    if [[ -e "$BACKUP_RUNTIME_DIR" || -L "$BACKUP_RUNTIME_DIR" ]]; then
      mv "$BACKUP_RUNTIME_DIR" "$RUNTIME_DIR"
    fi
  fi

  rm -rf "$STAGING_ROOT"
  if [[ "$SWAP_COMPLETE" -eq 1 ]]; then
    rm -rf "$BACKUP_RUNTIME_DIR"
  fi

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

is_macho_file() {
  file "$1" | grep -q "Mach-O"
}

require_macho_arch() {
  local label="$1"
  local path="$2"
  local archs

  if [[ ! -f "$path" ]]; then
    echo "ERROR $label missing at $path" >&2
    exit 1
  fi

  if ! is_macho_file "$path"; then
    echo "ERROR $label is not a Mach-O binary at $path" >&2
    exit 1
  fi

  archs="$(lipo -archs "$path" 2>/dev/null || true)"
  if [[ " $archs " != *" $EXPECTED_ARCH "* ]]; then
    echo "ERROR $label has architectures: ${archs:-unknown}; expected $EXPECTED_ARCH" >&2
    exit 1
  fi
}

validate_runtime_architectures() {
  local runtime_dir="$1"
  local path
  local archs
  local relative_path
  local checked=0
  local failed=0

  while IFS= read -r -d '' path; do
    if is_macho_file "$path"; then
      checked=$((checked + 1))
      archs="$(lipo -archs "$path" 2>/dev/null || true)"
      if [[ " $archs " != *" $EXPECTED_ARCH "* ]]; then
        relative_path="${path#"$runtime_dir"/}"
        echo "ERROR Runtime binary $relative_path has architectures: ${archs:-unknown}; expected $EXPECTED_ARCH" >&2
        failed=1
      fi
    fi
  done < <(find "$runtime_dir" -type f \( -perm -111 -o -name '*.so' -o -name '*.dylib' -o -name '*.node' \) -print0)

  if [[ "$checked" -eq 0 ]]; then
    echo "ERROR Runtime validation found no Mach-O binaries in $runtime_dir" >&2
    failed=1
  fi

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi

  echo "Validated $checked Mach-O runtime files for $EXPECTED_ARCH."
}

run_runtime_check() {
  local label="$1"
  local timeout_marker="$STAGING_ROOT/validation-timeout"
  local pid
  local watchdog_pid
  local status
  shift

  rm -f "$timeout_marker"
  "$@" >"$VALIDATION_STDOUT" 2>"$VALIDATION_STDERR" &
  pid=$!
  (
    sleep "$RUNTIME_CHECK_TIMEOUT_SECONDS"
    if kill -0 "$pid" 2>/dev/null; then
      touch "$timeout_marker"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!

  if wait "$pid"; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    echo "Validated $label."
    return
  fi
  status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [[ -f "$timeout_marker" ]]; then
    echo "ERROR Runtime $label timed out after ${RUNTIME_CHECK_TIMEOUT_SECONDS}s." >&2
  else
    echo "ERROR Runtime $label failed with exit code $status." >&2
  fi
  print_validation_output "stderr" "$VALIDATION_STDERR"
  print_validation_output "stdout" "$VALIDATION_STDOUT"
  exit 1
}

print_validation_output() {
  local label="$1"
  local output_path="$2"

  if [[ ! -s "$output_path" ]]; then
    return
  fi

  echo "      ${label}:" >&2
  sed -n '1,12p' "$output_path" | sed 's/^/      /' >&2
}

validate_runtime() {
  local runtime_dir="$1"
  local required_binary
  local missing=0
  local required_binaries=(
    "$runtime_dir/stemstudio-api/stemstudio-api"
    "$runtime_dir/stemstudio-worker/stemstudio-worker"
    "$runtime_dir/audio-separator/audio-separator"
    "$runtime_dir/yt-dlp/yt-dlp"
    "$runtime_dir/bin/ffmpeg"
    "$runtime_dir/bin/ffprobe"
    "$runtime_dir/bin/audio-separator"
    "$runtime_dir/bin/yt-dlp"
  )

  for required_binary in "${required_binaries[@]}"; do
    if [[ ! -x "$required_binary" ]]; then
      echo "ERROR Runtime executable missing or not executable at $required_binary" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi

  if [[ -n "$(find "$runtime_dir" -path '*/cache/models/*' -print -quit)" ]]; then
    echo "ERROR Desktop runtime contains model cache files. Keep downloaded separation models out of the app bundle." >&2
    exit 1
  fi

  validate_runtime_architectures "$runtime_dir"
  mkdir -p "$VALIDATION_DATA_DIR"
  run_runtime_check "API health check" env \
    STEMSTUDIO_DESKTOP_RESOURCES_DIR="$runtime_dir" \
    STEMSTUDIO_DESKTOP_USER_DATA_DIR="$VALIDATION_DATA_DIR" \
    "$runtime_dir/stemstudio-api/stemstudio-api" --health-check
  run_runtime_check "worker health check" env \
    STEMSTUDIO_DESKTOP_RESOURCES_DIR="$runtime_dir" \
    STEMSTUDIO_DESKTOP_USER_DATA_DIR="$VALIDATION_DATA_DIR" \
    "$runtime_dir/stemstudio-worker/stemstudio-worker" --health-check
  run_runtime_check "ffmpeg version" "$runtime_dir/bin/ffmpeg" -version
  run_runtime_check "ffprobe version" "$runtime_dir/bin/ffprobe" -version
  run_runtime_check "audio-separator version" "$runtime_dir/bin/audio-separator" --version
  run_runtime_check "yt-dlp version" "$runtime_dir/bin/yt-dlp" --version
}

run_runtime_build_step "setting up Python dependencies" env STEMSTUDIO_PYTHON_EXTRA=desktop "$SCRIPT_DIR/setup-python.sh"

mkdir -p "$BIN_DIR" "$BUILD_DIR" "$SPEC_DIR"

echo "Copying static ffmpeg and ffprobe binaries..."
require_macho_arch "ffmpeg" "$FFMPEG_BIN"
require_macho_arch "ffprobe" "$FFPROBE_BIN"
run_runtime_build_step "copying ffmpeg" cp "$FFMPEG_BIN" "$BIN_DIR/ffmpeg"
run_runtime_build_step "copying ffprobe" cp "$FFPROBE_BIN" "$BIN_DIR/ffprobe"
run_runtime_build_step "making ffmpeg and ffprobe executable" chmod 755 "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"

pyinstaller_common=(
  --clean
  --noconfirm
  --onedir
  --paths "$PROJECT_ROOT"
  --distpath "$STAGING_RUNTIME_DIR"
  --workpath "$BUILD_DIR"
  --specpath "$SPEC_DIR"
)

echo "Freezing StemStudio API..."
run_runtime_build_step "freezing StemStudio API" "$PYTHON_BIN" -m PyInstaller "${pyinstaller_common[@]}" \
  --name stemstudio-api \
  --collect-submodules uvicorn \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  backend/desktop/api_server.py

echo "Freezing StemStudio worker..."
run_runtime_build_step "freezing StemStudio worker" "$PYTHON_BIN" -m PyInstaller "${pyinstaller_common[@]}" \
  --name stemstudio-worker \
  backend/desktop/worker.py

echo "Freezing audio-separator..."
run_runtime_build_step "freezing audio-separator" "$PYTHON_BIN" -m PyInstaller "${pyinstaller_common[@]}" \
  --name audio-separator \
  --collect-all audio_separator \
  --copy-metadata audio-separator \
  backend/desktop/audio_separator_cli.py

echo "Freezing yt-dlp..."
run_runtime_build_step "freezing yt-dlp" "$PYTHON_BIN" -m PyInstaller "${pyinstaller_common[@]}" \
  --name yt-dlp \
  --collect-all yt_dlp \
  --copy-metadata yt-dlp \
  backend/desktop/yt_dlp_cli.py

write_launcher() {
  local launcher_name="$1"
  local dist_name="$2"
  local launcher_path="$BIN_DIR/$launcher_name"
  local launcher_script

  launcher_script="$(printf '%s\n%s\nexec "$SCRIPT_DIR/../%s/%s" "$@"' \
    '#!/usr/bin/env sh' \
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"' \
    "$dist_name" \
    "$dist_name")"

  if ! printf '%s\n' "$launcher_script" > "$launcher_path"; then
    echo >&2
    echo "ERROR Desktop runtime build stopped while writing the ${launcher_name} launcher." >&2
    echo "      Fix the error above, then rerun npm run desktop:runtime." >&2
    exit 1
  fi

  run_runtime_build_step "making ${launcher_name} launcher executable" chmod 755 "$launcher_path"
}

write_launcher "audio-separator" "audio-separator"
write_launcher "yt-dlp" "yt-dlp"

swap_runtime() {
  echo "Swapping validated runtime into $RUNTIME_DIR..."
  SWAP_IN_PROGRESS=1

  rm -rf "$BACKUP_RUNTIME_DIR"
  if [[ -e "$RUNTIME_DIR" || -L "$RUNTIME_DIR" ]]; then
    mv "$RUNTIME_DIR" "$BACKUP_RUNTIME_DIR"
  fi

  mv "$STAGING_RUNTIME_DIR" "$RUNTIME_DIR"
  SWAP_COMPLETE=1
  SWAP_IN_PROGRESS=0
  rm -rf "$BACKUP_RUNTIME_DIR"
}

echo "Validating staged desktop runtime..."
validate_runtime "$STAGING_RUNTIME_DIR"
run_runtime_build_step "swapping the validated runtime into place" swap_runtime

echo "Desktop runtime staged at $RUNTIME_DIR"
