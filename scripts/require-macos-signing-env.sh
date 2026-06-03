#!/usr/bin/env sh

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR macOS packaging must run on macOS." >&2
  exit 1
fi

HAS_CODE_SIGNING_ENV=0
if { [ -n "${CSC_LINK:-}" ] && [ -n "${CSC_KEY_PASSWORD:-}" ]; } || [ -n "${CSC_NAME:-}" ]; then
  HAS_CODE_SIGNING_ENV=1
fi

HAS_KEYCHAIN_IDENTITY=0
if command -v security >/dev/null 2>&1 &&
  security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  HAS_KEYCHAIN_IDENTITY=1
fi

if [ "$HAS_CODE_SIGNING_ENV" -ne 1 ] && [ "$HAS_KEYCHAIN_IDENTITY" -ne 1 ]; then
  echo "ERROR A Developer ID Application signing identity is required." >&2
  echo "      Set CSC_LINK and CSC_KEY_PASSWORD, set CSC_NAME, or install the identity in your keychain." >&2
  exit 1
fi

HAS_NOTARY_ENV=0
if { [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; } ||
  { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; }; then
  HAS_NOTARY_ENV=1
fi

if [ "$HAS_NOTARY_ENV" -ne 1 ]; then
  echo "ERROR Apple notarization credentials are required." >&2
  echo "      Use APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER; or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID." >&2
  exit 1
fi

echo "OK    macOS signing and notarization inputs are present."
