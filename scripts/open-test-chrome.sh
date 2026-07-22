#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENVIRONMENT="${1:-local}"
case "$ENVIRONMENT" in
  local)
    EXTENSION_DIR="$PROJECT_DIR/extension"
    PROFILE_NAME="carxpert-local-e2e-profile"
    DEBUG_PORT=9222
    ;;
  staging)
    EXTENSION_DIR="$PROJECT_DIR/dist/staging"
    PROFILE_NAME="carxpert-staging-e2e-profile"
    DEBUG_PORT=9223
    ;;
  prod)
    EXTENSION_DIR="$PROJECT_DIR/dist/prod"
    PROFILE_NAME="carxpert-prod-e2e-profile"
    DEBUG_PORT=9224
    ;;
  *)
    printf 'Usage: %s [local|staging|prod]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ ! -f "$EXTENSION_DIR/manifest.json" ]]; then
  printf 'Extension build not found: %s\n' "$EXTENSION_DIR" >&2
  printf 'Build it first (for example: npm run build:ext:staging).\n' >&2
  exit 1
fi

EXTENSION_PATH="$(wslpath -w "$EXTENSION_DIR")"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  "$(wslpath -w "$SCRIPT_DIR/open-test-chrome.ps1")" \
  "$EXTENSION_PATH" "$PROFILE_NAME" "$DEBUG_PORT"
