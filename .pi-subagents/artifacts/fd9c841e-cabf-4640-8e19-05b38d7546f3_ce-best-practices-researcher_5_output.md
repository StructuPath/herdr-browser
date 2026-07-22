Only pre-existing `.pi-subagents` artifacts from the parent session appear — I edited nothing. Here is the report.

---

# herdr-browser capability-upgrade research

**Grounding (what exists today).** The plugin (`herdr-plugin.toml` v0.4.0, `min_herdr_version 0.7.0`) ships 3 actions + 2 panes + 1 link handler. The viewer pane (`bin/renderer.mjs`) polls agent-browser by spawning **4 subprocesses per tick** (`get url`, `get title`, `console`, `screenshot`) on a 1s backoff-capable cadence, renders screenshots through chafa (`-f kitty|symbols`), injects clicks via `eval document.elementFromPoint(...)`, and types via `agent-browser type <text>`. Local versions: herdr **0.7.4**, agent-browser **0.28.0**, chafa **1.18.2** (= latest), carbonyl **0.0.2**.

## Ranked upgrades

### 1. Replace the poll loop with agent-browser's WebSocket stream — HIGH value / MEDIUM cost
The renderer re-implements what agent-browser already pushes. Every session runs a WS stream server (since ~v0.20; runtime `stream enable|status|disable` since 0.23 — **present in the tested 0.28.x**). One socket delivers: `frame` (base64 JPEG, q80, push-on-change), `console`, `page_error`, `url`, `tabs`, `status` messages, **plus inbound input injection** (mouse press/release/move/wheel, keyboard with modifiers, touch).
- Evidence: docs https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/streaming/page.mdx; message shapes confirmed in `cli/src/native/stream/cdp_loop.rs` (lines 89/134/154/184/210). **Verified live against installed 0.28.0**: `stream status` → port 54597; a 12-line Node WS client received status + a 15 KB JPEG frame for example.com.
- Value: kills 4 subprocess spawns/sec and the md5-compare/screenshot-to-disk dance; frames arrive only on change (CDP screencast); console becomes event-driven (no more ring-buffer reconciliation); `page_error` adds an exception channel the pane doesn't have. Node ≥22 has global `WebSocket`, zero new deps.
- Cost: rewrite of `tick()`/input in `bin/renderer.mjs` (~1–2 days). Keep the console display code; drop `reconcileConsole` entirely.

### 2. Render pixels through Herdr's native pane graphics API instead of chafa kitty escapes — HIGH value / MEDIUM cost
Herdr has a first-class image layer: `pane.graphics.set` (png/rgb/rgba, base64), `pane.graphics.info` (returns cell pixel dimensions), `pane.graphics.clear` — **all present in the installed 0.7.4** (verified via `herdr api schema --json`); 0.7.5 adds `pane.graphics.stream` (dedicated socket: one JSON header + raw bytes per frame; owns the layer until close; conflicts return `stream_conflict`). Gated by the same `[experimental].kitty_graphics = true` the README already requires.
- Evidence: https://herdr.dev/docs/socket-api/ ("Experimental pane graphics"); local schema shows `PaneGraphicsSetParams{pane_id, format, image_width, image_height, data_base64, placement{viewport_col, viewport_row, grid_cols, grid_rows}}`.
- Value: the renderer currently pipes screenshots through chafa, which **decodes the PNG and re-encodes to raw RGBA** — measured **2,485,874 bytes/frame** at 100×30 (`chafa -f kitty` emits `a=T,f=32,s=1000,v=460`). Pushing the screenshot PNG directly (15 KB for example.com; typically 50–300 KB) is **~10–100× less bandwidth**, drops the chafa dependency in pixel mode, survives Herdr redraws/reattach/remote clients (Herdr owns the layer), and `graphics.info` cell geometry makes click mapping exact instead of the `~1:2` aspect heuristic in `mapClickToPage`.
- Cost: unix-socket JSON client in the renderer + JPEG→PNG decode (frames from upgrade #1 are JPEG; `sharp`/`jimp` or macOS `sips`) or use `pane.graphics.set` with polled PNG screenshots as an intermediate step. `stream` needs `min_herdr_version 0.7.5` or a runtime fallback to `set`.

### 3. Fix the `i` prompt: `keyboard type`, not `type` — HIGH value / TRIVIAL cost (live bug)
`renderer.mjs` `onInput('i')` → `browser.type(text)` → `agent-browser type <text>`; in 0.28 the first arg is a **selector**, so every `i` submission fails.
- Evidence (verified live, 0.28.0): `agent-browser type "hello"` → `{"success":false,"error":"Element not found..."}`; `agent-browser keyboard type "hello"` → `{"success":true}`. CLI help: `keyboard type <text>  Type text with real keystrokes (no selector)`.
- Cost: one line in `makeBrowser.type` (call `keyboard type`). Same class of fix: `i` could accept modifiers via WS `input_keyboard` once #1 lands.

### 4. Click via real CDP mouse input instead of `eval elementFromPoint` — MEDIUM-HIGH value / LOW cost (free with #1)
Current clicks run JS in the page (`clickAt` → `eval`), which misses canvas-drawn targets, shadow-DOM retargeting edge cases, and anything intercepting synthetic `.click()`. agent-browser has `mouse move/down/up/wheel` CLI commands, and the WS stream accepts `input_mouse` with exact pixel coords.
- Evidence: `agent-browser --help` (Mouse section); streaming docs input-injection examples.
- Value: what-you-click-is-what-Chrome-clicks becomes literally true; also enables hover and drag later.
- Cost: trivial after #1 (send `input_mouse` press+release); ~½ day standalone via CLI.

### 5. Chafa flags for the symbols/ANSI path — MEDIUM value / TRIVIAL cost
Current invocation: `chafa -f <fmt> -s WxH --animate off --probe off <file>`. Measured improvements:
- **`--polite on`** — chafa emits its own `ESC[?25l` cursor-hide at the start of every frame (verified via `od -c`); the renderer manages cursor visibility itself and Herdr owns the pane, so chafa re-hiding is redundant and potentially confusing to the multiplexer. Polite removes it (verified).
- **`-c full`** — when chafa's stdout is a pipe (as in the renderer), color detection is heuristic; I verified it currently still emits 24-bit SGR (`38;2;…`), but pinning `-c full` makes that immune to heuristic changes.
- Quality knobs for symbols mode: `--color-space din99d` (perceptually accurate quantization), `--dither diffusion` (smooths gradients; default is `none` outside sixels), `-w 9` (most accurate) vs `-w 1` (cheapest). Benchmarked at 100×30 on an M-series Mac: all variants 110–140 ms/frame — the chafa subprocess is ~12% of the 1 s tick, so `-w 9` is affordable and `-O` level is irrelevant to kitty size (verified: `-O 0/5/9` identical 2.4 MB).
- Evidence: `chafa --help`; local benchmarks (commands in validation section). Chafa 1.18.2 is the latest release; no new canvas modes (formats remain kitty/sixels/iterm/symbols; 1.16 added probing/threaded I/O, 1.18 is hardening).

### 6. If self-rendered kitty mode stays as the fallback: transmit PNG directly with stable image IDs — MEDIUM value / MEDIUM cost
Per the Kitty spec (https://sw.kovidgoyal.net/kitty/graphics-protocol/):
- `f=100` transmits PNG bytes as-is (the renderer already holds the PNG) vs chafa's RGBA re-encode → the ~10–100× bandwidth win without Herdr ≥0.7.4 graphics.
- Chunking: base64, ≤4096-byte chunks, `m=1`…`m=0`; only the first chunk carries control keys; image lands at the cursor position of the **final** chunk.
- Animation/redraw: transmit once with a fixed image id `i=N`, display with `a=p,i=N,p=1`; re-sending the same (image id, placement id) **replaces in place without flicker**. Re-transmitting data for an id auto-deletes its placements.
- The current `KITTY_DELETE = Ga=d,d=A` deletes **all** images in the terminal, including any other client's — prefer `a=d,d=i,i=N` (delete by id).
- `C=1` suppresses cursor movement on placement; `q=2` silences terminal replies (important: any non-quiet responses arrive on stdin and would hit `onInput` as garbage — the existing probe already handles this correctly by pairing with DA1).
- Unicode placeholders (`U+10EEEE` + diacritics) exist precisely for host apps that redraw the screen (tmux/vim) — worth knowing, though upgrade #2 (Herdr-owned layer) makes manual kitty management moot where available.

### 7. Browse pane: install `carbonyl@next`, cap FPS, note dormancy — MEDIUM value / TRIVIAL cost
- README tells users `npm install -g carbonyl`, which resolves to dist-tag `latest` = **0.0.2-next.bacf3db**. The `next` tag = **0.0.3-next.ab80a27**, which is the v0.0.3 feature set: **quadrant rendering (sharper text), h.264, threaded compositing in bitmap mode, idle-CPU fix, Cmd-based nav** (changelog.md, 2023-02-18). Local install confirms 0.0.2.
- Flags (`src/cli/usage.txt`): `--fps` (default 60 — `--fps=30` halves CPU in a pane), `--zoom` (already supported via config), `--bitmap` (render text as bitmaps), `--debug`, plus most Chromium flags.
- **Deprecation/dormancy flag**: last commit 2023-02-27; bundled Chromium is ~3 years old. Fine for localhost dev pages; should not be recommended for general untrusted web browsing. Worth a README note and a `carbonyl@next` install line.

### 8. Adopt Herdr 0.7.5 lifecycle features (`[[startup]]`, `[[events]]`) — MEDIUM value / LOW-MEDIUM cost
0.7.5 (released 2026-07-21) adds one-shot **`[[startup]]` hooks** ("restore plugin-owned state after server startup and live handoff") — a natural place to reap stale `pane-id-*`/`browse-ids-*` files and orphaned `herdr-ws-*` sessions after a server restart. **`[[events]]`** hooks (validated at link time with warnings) can run cleanup on `workspace.closed` (kill that workspace's browser session) or react to `worktree.created`. Evidence: v0.7.5 release notes; https://herdr.dev/docs/plugins/; event names in https://herdr.dev/docs/socket-api/. Cost: two small scripts + manifest entries; requires `min_herdr_version = "0.7.5"` or tolerant no-op behavior on 0.7.4.

### 9. Surface page errors & network activity in the console area — MEDIUM value / LOW cost (free with #1)
`page_error` stream messages (exception text + line/column) and the existing `errors`/`network requests` CLI give a dev-verification pane the two signals it's missing. With #1, page errors arrive free; a `network requests --filter` summary line (pending/failed count) is a small addition. Evidence: cdp_loop.rs lines 200–214; `agent-browser network --help`.

### 10. Text-mode upgrade: accessibility snapshot view — MEDIUM value / MEDIUM cost
`agent-browser snapshot -i -c` returns the interactive a11y tree with refs. In `text` mode (no chafa/kitty) the pane currently shows console only; rendering the ref-annotated tree would let keyboard-only users see page structure and click by ref (`click @e3`) — far better than blind coordinate clicking. Evidence: `agent-browser --help` Snapshot section. Cost: a view mode + ref-based click command (~1 day).

### 11. Session persistence via 0.31 restore workflow — LOW-MEDIUM value / LOW cost
agent-browser 0.31 added `--restore`, `session id`/`session info`, `--namespace`, and autosave (`AGENT_BROWSER_AUTOSAVE_INTERVAL_MS`) — stable, automatically-restored browser state keyed per name, which maps cleanly onto Herdr workspaces/worktrees. Useful so the workspace session keeps cookies/localStorage across daemon reaps. Evidence: v0.31.0 release notes (#1486). Cost: pass flags at session creation in `open.sh`. Requires agent-browser ≥0.31 (version-matrix note below).

### 12. Debug-capture actions: `record` / `trace` — LOW value / LOW cost
`agent-browser record start <path>` (WebM video), `trace start/stop` (DevTools trace), `profiler` — could be two new plugin actions ("Start/Stop recording the workspace session") for bug reports. Evidence: `agent-browser --help` Debug section. Cost: ~½ day. Niche but cheap.

### 13. Version-matrix refresh: test against agent-browser 0.32.3 — necessary hygiene / LOW cost
Latest is **0.32.3** (tested: 0.28.x). Releases since: 0.29 (sandbox pkg), 0.30 (`read` command), 0.31 (restore workflow), 0.31.2 (`--webgpu`), 0.32 (eve ext, **HAR response-body capture**, domain-allowlist hardening). No breaking changes observed for commands the renderer uses; the one semantic landmine (`type`) is already covered by #3. Also note the existing `agent-browser dashboard` (0.23+) is a full observability web UI — don't rebuild what it gives free; the pane's niche is in-terminal live view.

### 14. Herdr features checked that are NOT available (so the current approach stays correct)
Plugin v1 has **no pane-input protocol, no status-line API, no mouse-passthrough API** — pane input arrives only through the pane's own PTY, which is exactly what the renderer already exploits (raw stdin + SGR mouse). Docs: "Runtime action registration and native non-terminal plugin UI are not part of plugin v1." Optional polish available today: `placement = "popup"` (with `width`/`height`) for a quick-look browse pane, and plugin panes are normal panes — `pane.resize/move/zoom` via CLI could auto-size the viewer to match the browser viewport aspect.

**Suggested sequencing:** #3 (one-line bug fix) → #5 (flag tweaks) → #7 (carbonyl@next) ship immediately; #1 (WS stream) is the foundation; #2 (Herdr graphics) builds on it; #4, #8, #9 ride along; #6 is the fallback path if #2 must support herdr <0.7.4 forever (it doesn't — `min_herdr_version` can move).

## Acceptance report