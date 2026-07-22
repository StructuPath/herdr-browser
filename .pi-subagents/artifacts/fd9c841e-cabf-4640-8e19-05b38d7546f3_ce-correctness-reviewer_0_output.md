Review complete. All files were read in full (renderer.mjs in 4 sequential reads, all 6 scripts, manifest, all 3 test suites), baseline tests run, and key suspicions verified empirically (chafa alignment, setTimeout overflow, tilde-dir creation).

```json
{
  "reviewer": "correctness",
  "findings": [
    {
      "id": "P1-1",
      "severity": "P1",
      "confidence": 60,
      "file": "scripts/open.sh",
      "line": "34-41",
      "title": "Stolen open-lock has no ownership token; holder's EXIT trap and repeat steals can produce duplicate panes",
      "detail": "When a waiter steals the lock (rm -rf at line 37), the original holder's `trap 'rmdir \"$lock\"' EXIT` (line 41) later removes the *stealer's* lock dir (mkdir locks are empty, so rmdir always succeeds) while the stealer is mid-critical-section. A third invoke then passes mkdir freely. Also, `tries` is never reset after a steal, so with two concurrent waiters the loser rm -rf's the winner's fresh lock on its very next iteration and both enter the critical section. Either path ends with two `herdr plugin pane open` calls or an orphaned untracked pane (the close.sh label-sweep mitigates the orphan). Requires concurrent opens with a >5s stall, which is exactly the double-invoke-on-slow-herdr scenario the lock exists for.",
      "fix": "Write a token ($$) into the lock dir after acquiring; in the EXIT trap only rmdir if the token still matches. Reset tries=0 after a successful steal, or steal at most once."
    },
    {
      "id": "P1-2",
      "severity": "P1",
      "confidence": 65,
      "file": "bin/renderer.mjs",
      "line": "468-470",
      "title": "selfCreated is set before browser.open() succeeds — a failed navigate makes the pane claim ownership of a session it didn't create",
      "detail": "navigate() sets selfCreated=true when sessionExists() is false, then awaits open(u). If open() throws (daemon down, Chrome failed to launch), userAction swallows the error but selfCreated stays true. If an agent later creates that same session independently, cleanup() on quit (line 497-502) will `agent-browser close` the agent's session. Note sessionExists() also returns false on daemon-unreachable (catch-all at line 170), making the false-positive path easier than it looks.",
      "fix": "Reset ownership on failure: `const existed = await this.browser.sessionExists(); try { await this.browser.open(u); } catch (e) { throw e; } if (!existed) this.selfCreated = true;` — or simply clear selfCreated in userAction's catch."
    },
    {
      "id": "P1-3",
      "severity": "P1",
      "confidence": 70,
      "file": "bin/renderer.mjs",
      "line": "544-549",
      "title": "Crash path leaves the terminal in raw mode (and mouse reporting) for 10 minutes",
      "detail": "The fatal catch writes only ESC[?1049l + ESC[?25h, then lingers 600s so the user can read the error. It never calls process.stdin.setRawMode(false) (raw mode was enabled in setupInput, line 357) and never emits ESC[?1000l/ESC[?1006l, so after any crash (e.g. EPIPE from a dying pty, OOM) the pane swallows keys without echo and keeps reporting mouse events until the 10-minute exit. Separately, SIGTERM/SIGHUP/SIGINT handlers are only registered at lines 531-533, after probe+redrawAll; a kill in that window (or during a slow first chafa render) terminates with default disposition and leaks the same terminal state.",
      "fix": "In the catch block call a restore routine: setRawMode(false) plus write ESC[?1000l ESC[?1006l before the 1049l/25h. Register signal handlers immediately after setupInput(), before the probe."
    },
    {
      "id": "P1-4",
      "severity": "P1",
      "confidence": 85,
      "file": "bin/renderer.mjs",
      "line": "360, 416-431",
      "title": "All prompt input is decoded as latin1 — non-ASCII URL/type text is deterministically corrupted to mojibake",
      "detail": "stdin chunks are decoded with chunk.toString('latin1') for byte-oriented escape parsing. promptInput then appends every char >= ' ' into the value, so typing 'café' or any CJK/emoji yields the UTF-8 bytes reinterpreted as latin1 characters (Ã© etc.), which are then submitted to agent-browser open/type as mojibake. URLs are mostly ASCII so 'u' rarely bites, but the 'i' (type into page) action corrupts any non-ASCII text. Fully deterministic for non-ASCII input; P1 only because the likely user base is ASCII-dominated.",
      "fix": "Keep a byte buffer for escape-sequence parsing, but decode prompt-mode input as utf8 (track mode: while promptState is active, buffer bytes and use new TextDecoder('utf-8', {stream:true})); or assemble the prompt value from a parallel utf8 decode of the same chunk."
    },
    {
      "id": "P1-5",
      "severity": "P1",
      "confidence": 55,
      "file": "scripts/lib.sh",
      "line": "8-12 (also bin/renderer.mjs:178-183)",
      "title": "HERDR_PLUGIN_STATE_DIR containing a literal '~' is used verbatim, creating a ./~ state tree under the cwd — evidence exists in this repo",
      "detail": "state_dir() and the Renderer constructor both use the env var (or the ~/.local fallback) without tilde expansion; tilde inside a variable value is never expanded by bash or by fs.mkdirSync. Verified: mkdir -p '~/.local/state/x' creates ./~/.local/state/x under the cwd. The repo itself contains the resulting artifact: ./~/.local/state/herdr/plugins/structupath.browser/pane-id-w2 — so this has already happened in a real run (all state: pane ids, locks, screenshots silently redirected into a per-cwd literal-tilde tree, breaking cross-invocation state). Current herdr passes absolute paths (per spike-out env dumps), hence P1 not P0.",
      "fix": "In state_dir() expand a leading '~/' to \"$HOME/\" (case \"${d}\" in '~/'*) d=\"$HOME/${d#~/}\";; esac); in the Renderer do the same before mkdirSync. Delete the stray ./~ directory from the repo."
    },
    {
      "id": "P2-1",
      "severity": "P2",
      "confidence": 40,
      "file": "bin/renderer.mjs",
      "line": "187, 538",
      "title": "intervalMs clamp has no upper bound — huge HERDR_BROWSER_INTERVAL_MS overflows setTimeout into a 1ms busy loop",
      "detail": "Math.max(250, ...) guards the low end only. pollDelay multiplies by up to 8, so any interval >= 2^31/8 (~268.4M ms) or 'Infinity' produces a delay > 2^31-1; Node clamps that to 1ms (verified: TimeoutOverflowWarning, fired after 2ms), turning the poll loop into a tight loop spawning 4 agent-browser subprocesses per tick. Requires an absurd env value, hence P2, but the code comment explicitly promises 'no busy-loop'.",
      "fix": "Clamp both ends: Math.min(86_400_000, Math.max(250, Number(env.HERDR_BROWSER_INTERVAL_MS) || 1000)) and/or cap pollDelay's output at 2**31 - 1."
    },
    {
      "id": "P2-2",
      "severity": "P2",
      "confidence": 70,
      "file": "bin/renderer.mjs",
      "line": "256-269",
      "title": "Symbols mode never erases the image region — a shrinking frame leaves stale rows/columns of the previous screenshot",
      "detail": "renderImage writes ESC[3;1H + chafa output. Verified with chafa 1.18.2: for a box of 40x20 cells and a wide image, chafa pads each emitted row to full width but emits only ceil(drawn height) rows (~10), not the full box. When a new screenshot has a shorter drawn height than the previous frame, the leftover rows below are never overwritten (kitty mode is fine — KITTY_DELETE clears placements). Stale pixels persist until a resize triggers redrawAll's ESC[2J.",
      "fix": "Before writing the chafa frame in symbols mode, erase the image box: for r in 3..3+imageRows-1 write ESC[<r>;1H ESC[K (or ESC[J after positioning at 3;1H, which would also clobber the console area — so per-row erase)."
    },
    {
      "id": "P2-3",
      "severity": "P2",
      "confidence": 60,
      "file": "bin/renderer.mjs",
      "line": "231-234, 321, 475",
      "title": "Sanitization gaps: session name is written to the terminal raw, and page text keeps Unicode bidi/format controls",
      "detail": "sanitizeText correctly strips C0/C1 (blocking escape-sequence injection — verified by test). But (a) header line 1 and the waiting/ended banners interpolate this.session without sanitizing; deriveSession only strips \\s, which does not match ESC (0x1b), so a hand-edited config 'session' file or HERDR_BROWSER_SESSION containing ESC bytes would inject sequences. (b) Page-controlled title/URL/console text retains Cf format chars (U+202E RLO etc.), allowing visual spoofing of the header — no escape injection, display-only. (c) The 'not an http(s) URL' banner echoes prompt input raw; prompt input admits bytes 0x80-0x9F (C1) via the latin1 path. All sources are local-user-controlled, hence P2 hardening nit.",
      "fix": "Run this.session through sanitizeText at derivation or display time; extend sanitizeText's class to include \\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF; sanitize the banner's interpolated user input."
    },
    {
      "id": "P2-4",
      "severity": "P2",
      "confidence": 60,
      "file": "scripts/lib.sh",
      "line": "35 (with scripts/open.sh:6, scripts/pane.sh:5, bin/renderer.mjs:28-29)",
      "title": "cksum session fallback hashes the plugin root (constant across all projects), and the JS fallback hashes a different cwd than the bash one",
      "detail": "open.sh/pane.sh cd to HERDR_PLUGIN_ROOT before sourcing lib.sh, so the $PWD hashed at lib.sh:35 is the plugin install directory — every workspace without HERDR_WORKSPACE_ID derives the SAME session name (cross-project session collision). The JS fallback uses process.cwd(), which matches only because pane.sh execs node from the plugin root; a direct `node bin/renderer.mjs` run from elsewhere derives a different name than the launchers used, so the pane never attaches. The lockstep tests (renderer.test.mjs) invoke lib.sh from the test cwd, which masks the production cd. Masked in practice because herdr always sets HERDR_WORKSPACE_ID (confirmed in spike-out env dumps) and pane.sh exports HERDR_BROWSER_SESSION — hence P2.",
      "fix": "Hash the workspace cwd instead: use HERDR_PLUGIN_CONTEXT_JSON's workspace_cwd (already provided by herdr) or $PWD captured before the cd; make the JS fallback read the same source."
    },
    {
      "id": "P2-5",
      "severity": "P2",
      "confidence": 45,
      "file": "bin/renderer.mjs",
      "line": "393-410, 113-118",
      "title": "No stdin sequence reassembly: split SGR mouse reports drop clicks; coalesced keypresses are dropped whole",
      "detail": "parseSgrMouse runs per-chunk; if a mouse report straddles two 'data' chunks both halves fail the regex and the click vanishes (the fragments then fall through to the key switch and match nothing). Conversely, if two keypresses arrive coalesced ('jj'), the switch on the whole chunk matches nothing and both scrolls are dropped. Raw-mode delivery is usually 1:1 so this is timing-dependent and rare.",
      "fix": "Keep a small pending-input buffer: append chunks, extract complete SGR sequences via regex with a global loop, then process remaining complete printable chars, retaining any trailing partial escape sequence for the next chunk."
    },
    {
      "id": "P2-6",
      "severity": "P2",
      "confidence": 30,
      "file": "scripts/open.sh",
      "line": "36",
      "title": "Non-numeric HERDR_BROWSER_LOCK_TRIES turns a stale lock into an infinite wait",
      "detail": "[ \"$tries\" -gt \"$HERDR_BROWSER_LOCK_TRIES\" ] with a garbage value makes test return 2 ('integer expression expected' on stderr every 100ms), which is falsy for the if, so the steal never fires and the until loop spins forever on a stale lock. Absurd env input, but the failure mode is silent hang + stderr spam.",
      "fix": "Sanitize once: case \"${HERDR_BROWSER_LOCK_TRIES:-50}\" in ''|*[!0-9]*) tries_max=50 ;; *) tries_max=$HERDR_BROWSER_LOCK_TRIES ;; esac"
    },
    {
      "id": "P2-7",
      "severity": "P2",
      "confidence": 35,
      "file": "bin/renderer.mjs",
      "line": "104-106, 318-330",
      "title": "Partial/corrupt PNG: no PNG signature check and no completeness validation before promoting tmp to the live shot",
      "detail": "pngDims only checks 'IHDR' at offset 12 (not the 8-byte PNG magic), and tick() renames tmp into place based solely on the screenshot CLI exiting 0. If agent-browser ever writes a truncated file while still exiting 0, the corrupt frame is promoted: chafa renders garbage (its error is swallowed) and clickAt happily maps clicks against the IHDR dims of a frame the user can't see correctly. The atomic rename and post-exit read are otherwise sound.",
      "fix": "Validate before promoting: check the 8-byte signature in pngDims and require the IEND chunk (buf.readUInt32BE(buf.length-8) === 0x49454e44) before rename; treat failure as a tick failure."
    },
    {
      "id": "P2-8",
      "severity": "P2",
      "confidence": 40,
      "file": "scripts/browse-pane.sh",
      "line": "17-22, 26-28",
      "title": "Typed URL keeps surrounding whitespace; zoom config is digit-stripped but never range-checked",
      "detail": "IFS= read -r url preserves leading/trailing spaces, so ' example.com' becomes 'https:// example.com' and carbonyl fails on an invalid URL. The zoom file value passes tr -cd '0-9' but '0' or '999999' go straight to carbonyl --zoom=.",
      "fix": "Trim after read (xargs or extglob); clamp zoom to a sane range (e.g. 25-500) with a default of 100 when out of range."
    },
    {
      "id": "P2-9",
      "severity": "P2",
      "confidence": 50,
      "file": "bin/renderer.mjs",
      "line": "91-93",
      "title": "truncate() counts UTF-16 code units, not terminal cells — CJK/wide titles overflow the header line",
      "detail": "A title full of CJK characters counts as length N but occupies 2N cells, so header lines wrap/overflow the pane width (reverse-video line 1 especially). Also truncate(s, 0) returns '…' (1 char into 0 width). Cosmetic only.",
      "fix": "Measure display width (e.g. strip to width cells using a wcwidth helper) and guard width <= 0 by returning ''."
    },
    {
      "id": "P2-10",
      "severity": "P2",
      "confidence": 60,
      "file": "bin/renderer.mjs",
      "line": "393-397, 500-502",
      "title": "UX nits: mouse clicks are processed while a prompt is open, and quit can block up to 8s in spawnSync close",
      "detail": "(a) onInput checks the mouse before promptState, so clicking during the URL/type prompt clicks the page behind the prompt (surprising state change mid-typing). (b) cleanup()'s spawnSync agent-browser close with an 8s timeout blocks the event loop on the quit path when the daemon is hung — the pane appears frozen on 'q'.",
      "fix": "(a) Route mouse events after the promptState check (or ignore clicks while prompting). (b) Acceptable, or reduce timeout to ~2s on the quit path — the daemon's idle reaper will collect it anyway."
    }
  ],
  "residual_risks": [
    "mapClickToPage assumes chafa top-left alignment and a ~1:2 cell ratio — verified empirically on chafa 1.18.2 (symbols mode), but the kitty output path (-f kitty) could not be verified without a kitty terminal, and a chafa default change would silently skew all click coordinates.",
    "clickAt assumes screenshot pixels == CSS pixels (deviceScaleFactor 1) for elementFromPoint; if agent-browser ever screenshots at DPR 2 every click lands at half the intended coordinates. Not verifiable from this repo.",
    "reconcileConsole's 'latest occurrence of tail window' heuristic can skip genuinely new entries when a page repeats identical log lines (ambiguous window match); it self-heals only on clear/rotation-marker.",
    "JSON schemas of agent-browser (data.sessions shape, console entries {text,type}, --json envelope) and herdr 0.7.x (pane-open output, pane list result.panes[].label) are assumed; drift degrades to 'waiting for session' or unparsed pane ids rather than loud errors.",
    "Zombie risk if the pty dies without SIGHUP: tick-loop EPIPEs are swallowed by enqueue's catch-all and the process keeps polling at backoff cadence forever."
  ],
  "testing_gaps": [
    "Input layer is untested: onInput key dispatch, promptInput editing/submit/cancel, latin1 non-ASCII corruption (P1-4), and split/coalesced chunk handling (P2-5) have no tests.",
    "tick() state machine untested: attach/detach transitions, failure counter reaching 3, session-ended banner path, and selfCreated-on-failed-open (P1-2) — the existing ownership test only covers the happy-path open.",
    "Crash/exit paths untested: cleanup() terminal-restore completeness (P1-3) and the pre-handler-registration signal window.",
    "open.sh lock: only the single-waiter stale-lock steal is tested; the holder-trap-vs-stealer and two-waiter races (P1-1) are untested.",
    "No test that symbols-mode frames erase the image region when the drawn size shrinks (P2-2).",
    "No test for upper-bound clamping of HERDR_BROWSER_INTERVAL_MS (P2-1) — current clamp test covers only low/garbage values.",
    "No fuzz/property test of reconcileConsole against streams with heavy duplicate lines (residual ambiguity)."
  ]
}
```

**Summary**: No P0s. The codebase is genuinely well-defended (atomic renames, paint-queue serialization, exact-match session checks, C0/C1 sanitization, lockstep tests). The most consequential findings are the **open-lock ownership race (P1-1)**, **session-ownership set before open succeeds (P1-2)**, **incomplete terminal restore on crash (P1-3)**, and **deterministic mojibake for non-ASCII prompt input (P1-4)**. The click-mapping geometry the task flagged as suspect is actually correct — I verified chafa 1.18.2 top-left alignment empirically, and the half-cell math inverts it consistently.