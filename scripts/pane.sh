#!/usr/bin/env bash
# Spike version of the pane entrypoint (U1). Dumps runtime context, renders a
# kitty-protocol and a symbols test image, then idles so probes can run.
set -u
OUT="${HERDR_PLUGIN_ROOT:-.}/spike-out"
mkdir -p "$OUT"

{
  echo "=== pane env $(date) ==="
  env | grep -E '^HERDR' | sort
  echo "=== context json ==="
  echo "${HERDR_PLUGIN_CONTEXT_JSON:-<unset>}"
  echo "=== tty ==="
  tty || true
  echo "cols=$(tput cols) lines=$(tput lines)"
} > "$OUT/pane-env.txt" 2>&1

echo "herdr-browser spike pane. env dumped to spike-out/pane-env.txt"

if [ -f "$OUT/test.png" ] && command -v chafa >/dev/null 2>&1; then
  echo "--- chafa -f kitty ---"
  chafa -f kitty -s "40x12" "$OUT/test.png"
  echo "--- chafa -f symbols ---"
  chafa -f symbols -s "40x12" "$OUT/test.png"
else
  echo "(no test.png or chafa yet)"
fi

echo "idling for probes; close pane or wait"
sleep 600
