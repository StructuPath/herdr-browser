#!/usr/bin/env bash
# Interactive browser pane: carbonyl renders Chromium straight into the
# terminal with full mouse/keyboard support. Prompts for a URL when none was
# passed, so a bare keybinding acts as an address bar.
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1

if ! command -v carbonyl >/dev/null 2>&1; then
  echo "herdr-browser: carbonyl not found."
  echo "Install it with: npm install -g carbonyl"
  echo "Then reopen this pane."
  sleep 600
  exit 1
fi

url="${HERDR_BROWSE_URL:-}"
if [ -z "$url" ]; then
  printf 'URL: '
  IFS= read -r url
  if [ -z "$url" ]; then
    exit 0
  fi
  case "$url" in
    http://*|https://*) ;;
    *) url="https://$url" ;;
  esac
fi

zoom="${HERDR_BROWSE_ZOOM:-}"
if [ -z "$zoom" ] && [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "${HERDR_PLUGIN_CONFIG_DIR}/zoom" ]; then
  zoom="$(head -n1 "${HERDR_PLUGIN_CONFIG_DIR}/zoom" | tr -cd '0-9')"
fi

exec carbonyl --zoom="${zoom:-100}" "$url"
