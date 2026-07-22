Audit complete. I read all 551 lines of `bin/renderer.mjs`, all 6 shell scripts, and all 3 test files in full; ran the suite (57/57 pass); and verified every claim below by executing code probes against the actual implementations.

```json
{
  "reviewer": "testing",
  "findings": [
    {
      "id": "T1",
      "severity": "high",
      "confidence": 85,
      "title": "Core safety invariant has zero coverage: tick()'s passive-viewer guard",
      "detail": "bin/renderer.mjs:290-299 — when unattached and the session doesn't exist, tick() must call ONLY sessionExists() and never url/title/console/screenshot (each of those auto-creates a headless Chrome on the daemon). This is the plugin's central 'stay truly passive' property and no test exercises tick() at all. A guard regression silently spawns a Chrome per workspace pane."
    },
    {
      "id": "T2",
      "severity": "high",
      "confidence": 90,
      "title": "Production behavior contradicts its own comment: navigate() accepts mailto:user@example.com",
      "detail": "bin/renderer.mjs:434-455. The comment claims schemes without // 'end up as a non-numeric port and fail parsing', but verified with node: 'mailto:user@example.com' → prefixed to 'https://mailto:user@example.com' → parses as valid https with userinfo → OPENED. Existing test only tries javascript:alert(1) (which does reject). Shell validate_url refuses all such input. No test pins scheme-less junk containing '@'. Low exploit impact (address-bar input only) but the policy divergence is real and unpinned."
    },
    {
      "id": "T3",
      "severity": "high",
      "confidence": 95,
      "title": "URL-policy drift between shell and JS is untested: uppercase schemes",
      "detail": "Verified by execution: scripts/lib.sh:41-47 validate_url is case-sensitive (bash case) → open.sh refuses 'HTTP://example.com' (exit 2); renderer navigate() accepts 'HTTP://caps.example' and tests/renderer.test.mjs explicitly asserts that acceptance. scripts/browse-pane.sh:20-23 mangles it worse → execs carbonyl with 'https://HTTP://example.com'. Comments in both places claim 'same policy'; the lockstep testing pattern used for session_name was never extended to URL policy."
    },
    {
      "id": "T4",
      "severity": "high",
      "confidence": 85,
      "title": "clickAt() untested end-to-end: SGR click → page-pixel eval pipeline",
      "detail": "bin/renderer.mjs:475-487. mapClickToPage is unit-tested in isolation, but clickAt's guards are not: clicks in header/console rows must not eval, missing/corrupt screenshot must not eval, and the generated JS must embed elementFromPoint(x,y) with correct coords. A geometry regression here silently clicks the wrong element on the user's real page."
    },
    {
      "id": "T5",
      "severity": "medium",
      "confidence": 80,
      "title": "Primary production path untested: open.sh via HERDR_PLUGIN_CLICKED_URL",
      "detail": "scripts/open.sh:14 — the localhost-link click path (the feature in the README's headline) passes the URL via env, not $1. All 19 launcher tests use argv. Also untested: clicked URL failing validation → exit 2; AGENT_BROWSER_IDLE_TIMEOUT_MS export reaching agent-browser."
    },
    {
      "id": "T6",
      "severity": "medium",
      "confidence": 80,
      "title": "tick() failure/degradation lifecycle untested",
      "detail": "bin/renderer.mjs:328-343 — failures 1–2 keep state; ≥3 with session alive → 'not responding — retrying'; ≥3 with session gone → detach + 'session ended' banner + failures reset; success resets failures=0. Also untested: screenshot-hash paths (same hash → tmp unlinked, renderImage skipped; different → rename + chmod 600)."
    },
    {
      "id": "T7",
      "severity": "medium",
      "confidence": 80,
      "title": "Session-ownership cleanup untested; binary name hardcoded (drift seam)",
      "detail": "bin/renderer.mjs:495-510 — cleanup() must spawn `agent-browser --session X close` ONLY when selfCreated (agent-owned sessions must survive pane quit; README 'session model' promises this). Untested both ways. Note: cleanup hardcodes 'agent-browser' (line 501) instead of reusing makeBrowser's bin — a rename would drift silently."
    },
    {
      "id": "T8",
      "severity": "medium",
      "confidence": 75,
      "title": "Address-bar input handling (promptInput) untested",
      "detail": "bin/renderer.mjs:415-430 — Enter submits trimmed value; empty Enter must NOT submit; Esc cancels; backspace; multi-char chunks; control chars ignored. Core UX, zero coverage."
    },
    {
      "id": "T9",
      "severity": "medium",
      "confidence": 75,
      "title": "pushConsole invariants untested (prefix map, raw-vs-sanitized split, 500-cap)",
      "detail": "bin/renderer.mjs:276-287 — ✖/⚠ prefixes; display lines sanitized while consoleState.tail stays RAW for reconcile matching (deliberate, commented, unpinned); 500-line cap with consolePushes staying monotonic (sig() and poll backoff depend on it)."
    },
    {
      "id": "T10",
      "severity": "medium",
      "confidence": 75,
      "title": "onInput gating untested + single-event-per-chunk asymmetry unpinned",
      "detail": "bin/renderer.mjs:388-407 — unattached pane must ignore b/f/r/i/j/k and mouse clicks (only u/q/Ctrl-C live). Also: switch(s) matches the WHOLE chunk so 'jj' in one read drops both scrolls, and parseSgrMouse (line 106) captures only the first SGR report per chunk — while promptInput loops per-char. Looks unintentional; no test pins either way."
    },
    {
      "id": "T11",
      "severity": "medium",
      "confidence": 75,
      "title": "open.sh error-exit contract untested (exit 3 / exit 4 / parse-warning paths)",
      "detail": "scripts/open.sh:27-30 (agent-browser open fails → exit 3), :58-61 (herdr pane open fails → exit 4), :63-68 (unparseable pane-open output → warning + pidfile removed + exit 0). Stubs only model success today."
    },
    {
      "id": "T12",
      "severity": "medium",
      "confidence": 70,
      "title": "pane.sh and browse-pane.sh have zero coverage",
      "detail": "pane.sh exports HERDR_BROWSER_SESSION from session_name — the actual glue of the JS/bash lockstep invariant — unpinned. browse-pane.sh: bare-host https:// prefixing (case-sensitive, mangles HTTP://), zoom config tr -cd '0-9' ('12a3'→'123', 'abc'→''→100), empty prompt → exit 0. All testable with stub node/carbonyl recording argv/env."
    },
    {
      "id": "T13",
      "severity": "low",
      "confidence": 80,
      "title": "Weak assertion: close-count regex passes with any number",
      "detail": "tests/launchers.test.mjs 'close reports what it did' asserts /closed \\d+ pane\\(s\\)/ — green even if close_pane counting (scripts/close.sh:14-20) always printed 0. Exact count is knowable per fixture ('closed 2 pane(s)' = tracked w9:p7 + swept w9:p9). Similarly, sweep-guard branches untested: no HERDR_WORKSPACE_ID or no node → sweep skipped."
    },
    {
      "id": "T14",
      "severity": "low",
      "confidence": 70,
      "title": "reconcileConsole edge matrix unpinned",
      "detail": "bin/renderer.mjs:38-63 — untested: empty prev.tail with count>0 (vacuous head-align below ring vs marker+full-set when saturated); prev.count === ringSize boundary with no rotation; duplicate/repeated tail texts (pages logging identical lines in loops) where the latest-occurrence suffix search is heuristic. Pin current behavior as regression anchor."
    },
    {
      "id": "T15",
      "severity": "low",
      "confidence": 70,
      "title": "makeBrowser.run edge paths untested (all feasible with existing stub pattern)",
      "detail": "bin/renderer.mjs:127-166 — success:false → throws parsed.error (and 'agent-browser error' fallback); console() object → d.messages ?? []; title() null → ''; sessionExists with garbage JSON / nonzero exit → false. Also pickRenderMode with invalid explicit value ('bogus') falling through to probe logic (line 72-78)."
    },
    {
      "id": "T16",
      "severity": "low",
      "confidence": 65,
      "title": "Minor brittleness: launcher tests regex-match exact flag order in stub log",
      "detail": "e.g. /herdr plugin pane open --plugin structupath\\.browser/ — a harmless flag reorder in the script breaks tests without behavior change. Acceptable given herdr's CLI contract; noted, not actionable. Renderer constructor side effects (mkdir/chmod/cksum/chafa probes) make unit tests env-dependent but tests already inject HERDR_PLUGIN_STATE_DIR."
    }
  ],
  "residual_risks": [
    "run()'s infinite poll loop (bin/renderer.mjs:534-539) — idleTicks/sig backoff progression — is unobservable without either a child-process integration test or extracting a step() seam; until one lands, backoff regressions ship silently.",
    "TTY-only paths (setupInput raw mode, probeKitty, resize debounce) can never be covered by pipe-based tests; if they matter, a PTY harness (e.g. node-pty) is a larger investment than anything proposed here.",
    "pattern.test.mjs assumes the Rust-regex subset in herdr-plugin.toml behaves identically to JS RegExp (documented in-file); a future pattern using lookaround/backrefs would silently invalidate all 17 pattern tests.",
    "F2/F3 fixes are production decisions (which URL policy is correct), not just test work — tests proposed below pin current behavior where safe and flag the two divergences for a decision."
  ],
  "testing_gaps": [
    "P0-1 tests/renderer.test.mjs :: 'tick stays passive when session is missing' — fake recording browser; r.attached=false, sessionExists→false; await r.tick(); assert url/title/console/screenshot NEVER called, banner mentions waiting. Covers T1. No seam needed.",
    "P0-2 tests/integration.test.mjs (new) :: 'renderer against stub agent-browser on PATH' — spawn node bin/renderer.mjs with stub binary (session list empty → later flips present and serves get/console/screenshot writing real PNG), HERDR_BROWSER_INTERVAL_MS=250, tmp state dir, pipe stdio. Assert: 'waiting for session' banner; stub log shows ONLY 'session list' while unattached; after flip, header shows sanitized URL; SIGTERM → exit 0 + shot files removed. Covers T1/T6 end-to-end. No production seam needed (env+PATH suffice).",
    "P0-3 tests/renderer.test.mjs :: 'clickAt maps in-image clicks and swallows out-of-image clicks' — write 24-byte PNG IHDR at r.shot, fix process.stdout.columns/rows (or stub r.size), capture browser.eval; assert elementFromPoint(x,y) coords match mapClickToPage; assert NO eval for header-row click, console-row click, missing shot, corrupt shot. Covers T4.",
    "P0-4 tests/renderer.test.mjs :: 'cleanup closes only self-created sessions' — PATH-stub agent-browser logging argv; selfCreated=true → cleanup() → log has '--session X close'; false → no close; shot/tmp unlinked. Covers T7. Optional seam: this.bin reused by cleanup instead of hardcoded 'agent-browser' (renderer.mjs:501).",
    "P0-5 tests/launchers.test.mjs :: 'open with HERDR_PLUGIN_CLICKED_URL navigates; bad clicked URL exits 2' — runScript('open.sh', [], env({HERDR_PLUGIN_CLICKED_URL:'http://localhost:3000'})) → open logged; 'file:///etc/passwd' → status 2, nothing logged. Covers T5.",
    "P0-6 tests/renderer.test.mjs :: 'tick failure lifecycle' — failing fake browser: failures 1-2 keep banner; 3rd with sessionExists→true → 'not responding — retrying'; with →false → detach + 'session ended' + failures reset; then success resets failures=0. Plus 'screenshot hash': same bytes twice → tmp unlinked + renderImage skipped (spy); new bytes → rename + chmod 600 + renderImage called. Covers T6.",
    "P1-7 tests/renderer.test.mjs :: 'promptInput submits/cancels/edits' — Enter submits trimmed value; empty Enter does not call onSubmit; Esc cancels; backspace edits; 'ab\\x7fc' chunk → 'ac'. Covers T8.",
    "P1-8 tests/renderer.test.mjs :: 'pushConsole prefixes, sanitizes display, keeps raw tail, caps at 500' — assert ✖/⚠/space prefixes; consoleLines contain no control chars; consoleState-compatible raw text preserved; after 600 pushes length=500 and consolePushes keeps counting. Covers T9.",
    "P1-9 tests/renderer.test.mjs :: 'onInput gates keys and clicks when unattached' — unattached: b/r/j/click are no-ops on fake browser, u opens prompt, q calls cleanup + stubbed process.exit; attached: keys drive. Pin single-event-per-chunk behavior (or fix switch→per-char loop first). Covers T10.",
    "P1-10 tests/renderer.test.mjs :: 'navigate rejects scheme-less junk with userinfo' — 'mailto:user@example.com', 'foo@bar.com', 'user:pass@evil.com', '//evil.com/x' — pin intended behavior. WILL FAIL against current code for the @ cases (T2) — lands with the production fix/decision.",
    "P1-11 tests/renderer.test.mjs + tests/launchers.test.mjs :: 'URL policy lockstep matrix' — shared case list (uppercase scheme, scheme-less, empty host, userinfo, flag-like) run through BOTH bash validate_url and JS navigate; assert agreed verdicts. Exposes T3; pin whichever policy is chosen.",
    "P1-12 tests/launchers.test.mjs :: 'open.sh failure exits' — stub agent-browser exits 1 on 'open' → status 3 + stderr hint + no pane; stub herdr fails 'plugin pane open' → status 4; herdr returns JSON without pane_id → warning + pidfile absent + status 0. Covers T11.",
    "P2-13 tests/renderer.test.mjs :: 'reconcile edge matrix' — empty tail with count>0 below and at ring size; count===ringSize no rotation → newEntries empty; duplicate tail texts → pinned latest-occurrence behavior. Covers T14.",
    "P2-14 tests/launchers.test.mjs :: 'close sweep guards + exact count' — no HERDR_WORKSPACE_ID → 'pane list' never called; PATH without node → sweep skipped, tracked closes still happen; assert exact 'closed 2 pane(s)' in the standard fixture (strengthens T13).",
    "P2-15 tests/launchers.test.mjs :: 'browse-pane.sh and pane.sh via stub carbonyl/node' — stdin-fed URL prompt; bare host → 'https://host'; zoom config '12a3' → --zoom=123, 'abc' → --zoom=100; pane.sh exports HERDR_BROWSER_SESSION equal to bash session_name for same env. Covers T12.",
    "P2-16 tests/renderer.test.mjs :: 'makeBrowser.run edge paths' — stub emits success:false → throws with error text; console returns {messages:[...]} → array; session list emits garbage/nonzero → sessionExists false; pickRenderMode('bogus') falls through to probe. Covers T15.",
    "P2-17 tests/renderer.test.mjs :: 'sanitizeText C0/C1 completeness sweep' — for all codepoints 0x00–0x9F: output contains no char in 0x00–0x1F/0x7F–0x9F, tab→space, 0x20 preserved. Property-style completeness test instead of sampled chars.",
    "P2-18 tests/renderer.test.mjs :: 'enqueue tolerates rejection; userAction still ticks after action throws' — throwing enqueued fn doesn't poison paintQueue; userAction with throwing action swallows and enqueues a tick. Covers paint-queue error contract (renderer.mjs:205-208, 442-447)."
  ]
}
```

**Production seams needed** (all optional — every P0 works today): (a) `cleanup()` should reuse the browser binary name instead of hardcoding `'agent-browser'` at `bin/renderer.mjs:501` (drift risk + simplifies T7 test); (b) extracting a `step()` from `run()`'s loop body (`bin/renderer.mjs:534-539`) would make backoff unit-testable, though P0-2 covers it via integration; (c) `onInput`'s whole-chunk `switch` vs `promptInput`'s per-char loop asymmetry (`bin/renderer.mjs:398` vs `:417`) should be decided before pinning with P1-9.

**Two findings are production bugs/decisions surfaced by the audit, not just test gaps:** T2 (`mailto:user@example.com` opens as `https://mailto:user@example.com/`, contradicting the inline comment — verified) and T3 (shell refuses `HTTP://…` while the JS test asserts acceptance — verified). P1-10 and P1-11 will fail until those are resolved.