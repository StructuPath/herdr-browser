All files read, all measurements taken. Here is the analysis.

---

# Performance Oracle Report: herdr-browser

## Measured baseline (this machine, warm daemon)

| Operation | Measured |
|---|---|
| `agent-browser` CLI spawn + daemon round-trip (`session list --json`) | **4–6 ms** (compiled Mach-O binary, not a node cold start) |
| `chafa -f kitty -s 120x30` on a 1280×577 PNG | **32 ms**, emits **3.63 MB** |
| `chafa -f symbols -s 120x30` | **19 ms**, emits **11 KB** (80x20: 5.1 KB) |
| `JSON.parse` of a 2.9 MB console payload (1000 entries × 3 KB) | **2 ms** |
| chafa kitty @ 80x20 | 1.64 MB |

Per attached tick (base cadence 1 s): 4 CLI spawns (~16–24 ms), Chrome viewport capture + PNG encode (daemon-side, the dominant per-tick CPU), PNG write→read→md5 (~1 MB disk round trip), and on changed frames a chafa spawn + 5 KB–3.6 MB TTY write.

## What's already good (verified, no action)

- **Hash-skip exists** — `renderer.mjs:320-327` md5s the fresh screenshot and skips both the rename and the chafa run when unchanged. chafa is never re-run on identical frames.
- **Backoff exists** — `pollDelay` (`renderer.mjs:87-90`) steps 1×/2×/4×/8× and any sig change resets it. Correct shape.
- **Memory is bounded** — `consoleLines` capped at 500 (`renderer.mjs:285-286`), one shot file + one tmp (renamed or unlinked every tick), 8-entry reconcile tail, no listener leaks, paint queue is a settled-promise chain.
- **Console JSON parse cost is a non-issue** — 2 ms for a 2.9 MB worst-case payload; `reconcileConsole` common path is O(8) (`renderer.mjs:35-60`).
- **chafa spawn-per-frame** — gated to changed frames only; 19–32 ms is acceptable and chafa is a one-shot CLI (can't be kept warm without replacing it).
- **Console incremental-fetch gap is forced by the CLI** — `agent-browser console` has only `--clear`, no cursor/since (verified `--help`). The full-ring pull per tick is currently unavoidable via that command.
- scripts/*.sh: open-lock spin is bounded (50 × 100 ms, `open.sh:34-42`), close-time spawns are one-time. No steady-state cost.

---

## Critical Issues

### P0 — Console fetch has the default 1 MiB `execFile` maxBuffer → permanent failure loop with 5 wasted spawns/tick

**`bin/renderer.mjs:129-143`** — `makeBrowser().run()` calls `pExecFile` with **no `maxBuffer`**, so Node's default 1 MiB applies. `renderImage` correctly sets 32 MB for chafa (`renderer.mjs:255-257`); the CLI calls got nothing.

- **Trigger**: the daemon keeps a 1000-entry console ring. Dev pages with error spam (vite/webpack stacks, React warnings) easily reach 2–5 KB/entry → 2–5 MB payload → every `console()` call throws `maxBuffer exceeded`.
- **Blast radius**: the throw aborts the whole `try` in `tick()` (`renderer.mjs:305-334`), so `Promise.all` rejects → **screenshot is skipped, image freezes, console freezes**. After 3 failures every tick additionally spawns `sessionExists` (`renderer.mjs:336`) → 5 spawns/tick of 100% wasted work, forever, under a misleading "agent-browser not responding — retrying" banner while the browser is fine.
- **Projected impact at scale**: guaranteed eventual total pane failure on any noisy page; the pane never recovers even if the console later shrinks below 1 MiB (it flaps instead).
- **Fix**: `maxBuffer: 16 * 1024 * 1024` on both `pExecFile` sites (129, 162), and surface buffer-overflow distinctly from daemon-down. One-line fix.

### P1-1 — Screenshot is captured, encoded, written, read, and hashed every tick even when the page never changes

**`bin/renderer.mjs:318-327`** — the md5 skip happens *after* Chrome has already done the most expensive work: CDP capture → PNG encode (20–60 ms daemon CPU for 1280×577+) → disk write → renderer `readFileSync` → md5 → usually `unlinkSync`. On a static page that entire chain is pure waste, repeated every 1–8 s for the life of the pane.

- **Expected win**: eliminates ~the dominant per-tick cost on static pages, i.e. nearly all ticks in the common case.
- **Options** (in order):
  1. **Push model**: agent-browser 0.28 ships `stream enable` — a session-scoped WebSocket with CDP-screencast frame streaming ("WebSocket clients trigger frame streaming automatically", verified `--help`). Chrome pushes frames only when the page paints. This deletes screenshot polling entirely and is the architecturally correct fix; bigger change (WS client in the renderer).
  2. **Cheap dirty-probe**: keep polling but gate the capture behind a sub-ms `eval` of a paint/mutation counter. Caveat: installs JS in the page, which sits awkwardly with the pane's "truly passive" contract — option 1 is cleaner.

### P1-2 — 4 CLI spawns per tick; `agent-browser batch --json` collapses them to 1

**`bin/renderer.mjs:306-307` + `319`** — url/title/console are three separate spawns, screenshot a fourth. Verified `agent-browser batch` exists: `batch "get url" "get title" "console" "screenshot <tmp>"` runs them in one process and returns a JSON array in order.

- **Measured**: 4–6 ms/spawn warm → saves ~12–18 ms spawn overhead + 3 daemon connection setups per tick (~75% fewer spawns), and one `JSON.parse` instead of four. At 1 s cadence that's ~20% less renderer-side tick CPU; bigger relative win at `HERDR_BROWSER_INTERVAL_MS=250`.
- **Implementation complexity**: low — `batch` is already the CLI's supported multi-command path; the `--bail` semantics even match the current all-or-nothing tick.

### P1-3 — Kitty frames transmit full-resolution RGBA: measured 3.6 MB per frame from a 15 KB source PNG

**`bin/renderer.mjs:250-262`** — `chafa -f kitty` re-encodes the image as raw pixel data; measured **3.63 MB @ 120x30** (1.64 MB @ 80x20) from a 1280×577, 15 KB PNG. Every changed frame writes megabytes into the pty, plus `KITTY_DELETE` first (`renderer.mjs:259`).

- **Fix**: in kitty mode, skip chafa and emit the graphics protocol directly — Kitty supports `f=100` (PNG passthrough): base64 the on-disk screenshot PNG as-is, chunked at **≤4096 bytes** with `m=1`/`m=0` continuations (the chunk-size constraint you asked about — chafa currently does this chunking for you; a hand-rolled emitter must respect it), placed with `a=T,c=<cols>,r=<rows>` so the terminal scales into the cell box.
- **Expected win**: per-frame bytes drop from (width×height×4)×4/3 to the PNG file size — typically **3–10× fewer TTY bytes** (real page PNGs are 100 KB–1 MB vs 2–4 MB RGBA), plus the 20–35 ms chafa spawn vanishes. Terminal must re-scale, which Kitty/Ghostty do in GPU.
- **Caveat**: verify `f=100` support on WezTerm before removing the chafa path (Kitty/Ghostty: yes). Keep chafa for `symbols` mode regardless (11 KB/frame is fine).

### P1-4 — No suspension while the pane is unfocused; idle floor is 4–5 spawns + a full screenshot every 8 s forever

**`bin/renderer.mjs:536-538`** — backoff caps at 8× (`pollDelay`, `:87-90`) but never reaches zero. A pane left open overnight in a background tab runs the full tick chain ~10,000 times. The waiting-for-session path is fine (1 spawn/8 s, `:296`), and failure state is 5 spawns/8 s (`:336`).

- **Expected win**: up to 100% of plugin cost when nobody is watching.
- **Fix**: if herdr exposes pane visibility/focus to the pane process, suspend the loop on hidden (best). Otherwise add backoff tiers — e.g. 30 s after 5 min idle, 60 s after 30 min — since `sig()` already detects "nothing happened" correctly and any input resets to base cadence.

---

## Optimization Opportunities (P2)

1. **Screenshot serialized after metadata** — `renderer.mjs:319` awaits `screenshot` *after* the `Promise.all` at `:306-307` settles. The four calls are independent; folding screenshot into the same batch/parallel set cuts tick latency by one full CLI round-trip (~10–40 ms). Complexity: trivial. (Subsumed by P1-2 if batch is adopted.)

2. **Header rewritten every tick** — `renderer.mjs:344` (and `:298` while waiting) writes 3 cursor-positioned lines (~150–300 B) even when `sig()` is unchanged; `renderConsole` (`:265-273`) repaints the whole console region (rows × cols bytes, up to ~3.4 KB on tall panes) for any batch of new entries instead of scroll-appending the delta. Byte-wise trivial, but gating `header()` on a url/title/banner change and appending-only for console removes all steady-state TTY traffic between real changes. Complexity: low.

3. **chafa stdout buffered to 32 MB then written in one call** — `renderer.mjs:255-261`. Spawning chafa with stdout piped straight to `process.stdout` would cut peak RSS (a 3.6 MB frame is held whole) and time-to-first-byte. Moot for kitty if P1-3 lands; still applies to symbols mode (11 KB — honestly marginal there).

4. **PNG → JPEG screenshots** — `renderer.mjs:152` uses defaults; agent-browser supports `--screenshot-format jpeg --screenshot-quality` (verified `--help`). JPEG shrinks the per-tick write/read/hash chain ~50–80% on photographic pages and speeds chafa decode. Blocker: `pngDims` (`renderer.mjs:93-96`) feeds click-mapping at `:479`; needs a ~15-line JPEG SOF0 scanner. Complexity: low-medium.

5. **Tmp-PNG disk round trip** — write by daemon → `readFileSync` → rename/unlink every tick (`:318-327`). Could pass the image on stdout instead of via the filesystem (screenshot to `-`?) — agent-browser currently requires a path, so this needs CLI support; file under "nice to have", ~1–3 ms + fs churn per tick.

## Scalability Assessment

- **Data volume**: console ring is fixed at 1000 entries → worst-case tick payload ~3 MB; parse cost stays ~2 ms; the binding constraint is the 1 MiB maxBuffer (P0), not volume scaling.
- **Time**: cost scales linearly with pane lifetime and inversely with backoff — the 8 s floor (P1-4) and per-tick screenshot (P1-1) are the only unbounded-lifetime costs. With P1-1 + P1-4 fixed, an idle pane costs ~zero.
- **Concurrency**: each renderer is independent; N panes on one daemon serialize at the daemon. 4 spawns/tick/pane → N panes × 4 spawns is process-table churn batch (P1-2) quarters.
- **TTY**: kitty mode at a change-heavy 1 s cadence writes 1.6–3.6 MB/s into the pty; on a slow terminal emulator this is the one path that can actually saturate something. P1-3 addresses it.

## Recommended Actions (priority order)

1. **P0**: add `maxBuffer` to both agent-browser `pExecFile` calls (`renderer.mjs:129,162`). One line each.
2. **P1-2**: switch the tick to `agent-browser batch --json`. ~1 day, includes P2-1.
3. **P1-3**: hand-roll kitty `f=100` emission with 4096-byte chunks; keep chafa for symbols. ~1 day + WezTerm verification.
4. **P1-4**: extend backoff tiers or hook pane visibility. Hours.
5. **P1-1**: adopt `stream enable` screencast push when the pane can hold a WebSocket; until then the md5 gate stays as the correctness floor. Larger; schedule separately.
6. **P2-2/3/4**: batch as one cleanup pass.