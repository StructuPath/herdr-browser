#!/usr/bin/env bash
# Shared helpers for herdr-browser launcher actions.

HERDR="${HERDR_BIN_PATH:-herdr}"
# shellcheck disable=SC2034  # consumed by open.sh after sourcing
PLUGIN_ID="structupath.browser"

state_dir() {
  local d="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-browser}"
  # A literal leading '~' inside a variable value is never expanded by bash;
  # expand it ourselves or state silently lands in a per-cwd './~' tree.
  # shellcheck disable=SC2088 # the literal tilde is the match target, on purpose
  case "$d" in
    '~'|'~/'*) d="$HOME${d#\~}" ;;
  esac
  # Relative paths would scatter state across cwds; fall back to the default.
  case "$d" in
    /*) ;;
    *) d="$HOME/.local/state/herdr-browser" ;;
  esac
  mkdir -p "$d"
  chmod 700 "$d"
  printf '%s\n' "$d"
}

# Workspace id as used in file names (locks, pane-id files, shot names).
# herdr owns the id, but it is interpolated into paths — including an
# rm -rf in open.sh's lock steal — so only a strict charset may pass.
# Must stay in lockstep with safeWsId() in bin/renderer.mjs.
ws_id() {
  local id
  id="$(printf '%s' "${HERDR_WORKSPACE_ID:-default}" | tr -cd 'a-zA-Z0-9_-')"
  printf '%s\n' "${id:-default}"
}

# herdr CLI preflight: a missing binary otherwise surfaces as the wrong error
# ('failed to open pane') downstream.
require_herdr() {
  if ! command -v "$HERDR" >/dev/null 2>&1; then
    echo "herdr-browser: herdr CLI not found (set HERDR_BIN_PATH)." >&2
    exit 1
  fi
}

# Portable timeout (macOS lacks GNU timeout): poll the child and SIGKILL it
# after SECONDS. Done in-shell (no background watchdog) so a dying script
# can never orphan a sleep that holds the caller's stdout pipe open.
with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge "$((secs * 10))" ]; then
      kill -9 "$pid" 2>/dev/null
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done
  wait "$pid" 2>/dev/null
  return $?
}

# Session precedence: env override > config file > workspace id > cwd hash.
# Must stay in lockstep with deriveSession() in bin/renderer.mjs (pane.sh
# exports the resolved name, so the JS copy is a fallback only).
session_name() {
  # Control chars are stripped from every source: the name is written into
  # the user's terminal by the renderer, so ESC must never survive. A value
  # that strips to nothing falls through to the next source.
  if [ -n "${HERDR_BROWSER_SESSION:-}" ]; then
    local clean
    clean="$(printf '%s' "$HERDR_BROWSER_SESSION" | tr -d '[:space:][:cntrl:]')"
    if [ -n "$clean" ]; then
      printf '%s\n' "$clean"
      return
    fi
  fi
  if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "${HERDR_PLUGIN_CONFIG_DIR}/session" ]; then
    local cfg
    cfg="$(head -n1 "${HERDR_PLUGIN_CONFIG_DIR}/session" | tr -d '[:space:][:cntrl:]')"
    if [ -n "$cfg" ]; then
      printf '%s\n' "$cfg"
      return
    fi
  fi
  if [ -n "${HERDR_WORKSPACE_ID:-}" ]; then
    printf 'herdr-ws-%s\n' "$(ws_id)"
    return
  fi
  printf 'herdr-cwd-%s\n' "$(printf '%s\n' "$PWD" | cksum | cut -d' ' -f1)"
}

require_agent_browser() {
  if ! command -v agent-browser >/dev/null 2>&1; then
    echo "herdr-browser: agent-browser CLI not found." >&2
    echo "Install it with: npm install -g agent-browser && agent-browser install" >&2
    exit 1
  fi
}

# Only plain http(s) URLs pass; flag-like, credential-bearing, and
# exotic-scheme values are refused. Schemes are matched case-insensitively
# (RFC 3986) so the launchers and the renderer's navigate() agree.
validate_url() {
  case "$1" in
    -*) return 1 ;;
    [hH][tT][tT][pP]://?*|[hH][tT][tT][pP][sS]://?*) ;;
    *) return 1 ;;
  esac
  # No userinfo in the authority (user@host / user:pass@host).
  local auth="${1#*://}"
  auth="${auth%%/*}"
  case "$auth" in
    *@*) return 1 ;;
  esac
  return 0
}

pane_id_file() {
  printf '%s/pane-id-%s\n' "$(state_dir)" "$(ws_id)"
}

# Browse panes are many-per-workspace; ids are appended, one per line.
browse_ids_file() {
  printf '%s/browse-ids-%s\n' "$(state_dir)" "$(ws_id)"
}

# First pane_id in herdr JSON output. Whitespace-stripped first so compact
# and pretty-printed responses both parse (pane ids never contain spaces).
parse_pane_id() {
  printf '%s' "$1" | tr -d ' \n\r\t' | grep -o '"pane_id":"[^"]*"' | head -n1 | cut -d'"' -f4
}

pane_alive() {
  [ -n "$1" ] && "$HERDR" pane read "$1" --lines 1 >/dev/null 2>&1
}
