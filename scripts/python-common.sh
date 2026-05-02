find_python() {
  for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi
    binary="$(command -v "$candidate")"
    if is_supported_python "$binary"; then
      printf '%s\n' "$binary"
      return 0
    fi
  done
  return 1
}

is_supported_python() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

python_version() {
  "$1" -c 'import sys; print(".".join(str(part) for part in sys.version_info[:3]))'
}
