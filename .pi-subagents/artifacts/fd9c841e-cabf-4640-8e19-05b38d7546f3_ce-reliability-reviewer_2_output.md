Review complete. All files read (renderer.mjs 551 lines, 6 shell scripts, 3 test files, manifest, package.json, README), 57/57 tests confirmed passing, and the lock race was verified with a live reproduction.

```json
{
  "reviewer": "reliability",
  "findings": [
    {
      "id": "REL-P1-01",
      "severity": "P1",
      "confidence": 100,
      "file": "scripts/open.sh",
      "line": "34-39",
      "title": "Stale-lock steal breaks mutual exclusion when two waiters race",
      "detail": "The acquire loop never resets `tries` after stealing: once `tries > HERDR_BROWSER_LOCK_TRIES`, EVERY subsequent failed `mkdir` re-runs `rm -rf \"$lock\"` (line 37). Two open actions waiting on a crashed holder's stale lock: A steals (rm -rf), B wins the next mkdir and enters the critical section, A's retry fails and — tries still >50 — A rm -rf's B's live lock and enters too. Both run `herdr plugin pane open` concurrently: duplicate panes, the exact failure the lock exists to prevent. VERIFIED by reproduction (both contenders logged ENTER before either EXIT). Secondary cascade: duplicate view panes in one workspace share `shot-<ws>.png` and `shot-<ws>.png.tmp`, so one renderer's renameSync can capture the other's partially-written screenshot (corrupt frame + ENOENT failure counts).",
      "remediation": "Reset `tries=0` immediately after a steal (or steal at most once per waiter, then keep waiting); prefer storing the holder PID in the lock and validating staleness with `kill -0` instead of a blind timeout; make the renderer tmp file unique per process (e.g. `shot-<ws>.<pid>.tmp`) so a duplicate pane cannot corrupt another's frame."
    },
    {
      "id": "REL-P1-02",
      "severity": "P1",
      "confidence": 75,
      "file": "bin/renderer.mjs",
      "line": "336-343 (detach), 468-469 (set), 497-503 (use)",
      "title": "Session ownership (selfCreated) never lapses when the session dies — pane later kills a session it no longer owns",
      "detail": "selfCreated is set at navigate() and only ever read in cleanup(); it is never reset. Sequence: user navigates in pane (selfCreated=true, pane 'owns' the session) → the plugin's own default AGENT_BROWSER_IDLE_TIMEOUT_MS=1800000 (line 146) lets the daemon self-reap after 30 min idle → tick() detaches at line 339 (attached=false, selfCreated untouched) → an agent later creates a fresh session with the same name → pane re-attaches → user presses q → cleanup() runs `agent-browser --session X close` and kills the agent's live browser. Ownership must die with the session that granted it.",
      "remediation": "Clear `this.selfCreated = false` in the detach branch (lines 339-341) alongside `this.attached = false`. For stronger identity, record a nonce/creation timestamp at self-creation (e.g. via eval) and verify before closing in cleanup()."
    },
    {
      "id": "REL-P1-03",
      "severity": "P1",
      "confidence": 90,
      "file": "scripts/open.sh:22, scripts/close.sh:49, scripts/close.sh:14, scripts/lib.sh:71",
      "line": "see file list",
      "title": "No timeout on any agent-browser or herdr CLI invocation in the shell scripts",
      "detail": "The JS renderer wraps every agent-browser call in a 10s execFile timeout, but the scripts have no equivalent. If the daemon hangs (mid-upgrade, wedged Chrome, socket deadlock), `agent-browser --session X open` in open.sh hangs the herdr action forever; `agent-browser close` in close.sh hangs the whole close action (panes never closed, session never released, lock-free but stuck); `herdr pane read` in pane_alive and `herdr pane close` have the same exposure if the herdr CLI itself wedges. Re-invoking just stacks more hung actions.",
      "remediation": "Wrap external calls in a watchdog. macOS lacks GNU `timeout`, so use a portable pattern: run the command in the background, poll `kill -0` with a deadline, then `kill`/`kill -9` the child (or check whether agent-browser/herdr expose their own --timeout flags and thread HERDR_BROWSER_CMD_TIMEOUT_MS through)."
    },
    {
      "id": "REL-P1-04",
      "severity": "P1",
      "confidence": 85,
      "file": "bin/renderer.mjs:296-301 (wait branch), 160-168 (sessionExists), scripts/pane.sh:6-12",
      "line": "see file list",
      "title": "agent-browser not installed → pane shows 'waiting for session' forever with advice that can never work",
      "detail": "pane.sh checks for node but never for agent-browser. sessionExists() swallows every error — including execFile ENOENT for a missing binary — and returns false, so a missing engine is indistinguishable from 'session not started yet'. The pane then banners 'waiting for session — have your agent use --session X' indefinitely; following that advice (or clicking a localhost link, which open.sh refuses at require_agent_browser) cannot help. The README troubleshooting section reinforces the misdiagnosis. open.sh does check (require_agent_browser) — only the pane entrypoint has the hole.",
      "remediation": "Probe for the binary once at renderer startup (same spawnSync('sh','-c','command -v …') pattern already used for chafa at line 185) and show the install instructions (`npm install -g agent-browser && agent-browser install`) instead of the waiting banner; in sessionExists, let ENOENT surface as 'not installed' rather than 'not running'."
    },
    {
      "id": "REL-P2-01",
      "severity": "P2",
      "confidence": 75,
      "file": "bin/renderer.mjs",
      "line": "29-32",
      "title": "deriveSession cwd fallback: spawnSync with no timeout, null-stdout deref, and empty-hash session collision",
      "detail": "Three weaknesses in the dev-only fallback: (1) spawnSync('sh', …) has no timeout — a wedged shell blocks the constructor. (2) If 'sh' can't be spawned, the result's stdout is null → `.stdout.toString()` throws TypeError → constructor throws → crash path leaves a dead pane lingering 10 minutes. (3) If cksum is missing/stdout empty, the name becomes the literal `herdr-cwd-` for every project — all fallback panes attach to one shared session. Additionally pane.sh cd's to the plugin root before resolving, so both bash and JS hash the plugin directory, not the workspace cwd — fallback names collide across all workspaces on the machine anyway.",
      "remediation": "Add `timeout: 5000` to the spawnSync, guard `const out = result.stdout?.toString() ?? ''` and fall back to a fixed 'herdr-cwd-unknown' banner-visible name (or refuse to start) when the hash is empty; consider hashing an explicit workspace identifier rather than $PWD."
    },
    {
      "id": "REL-P2-02",
      "severity": "P2",
      "confidence": 80,
      "file": "bin/renderer.mjs",
      "line": "250-262",
      "title": "chafa spawned per frame with 15s timeout but no circuit breaker; failures fully swallowed",
      "detail": "A persistently hanging chafa (the very case the timeout exists for) makes every frame-costing tick burn 15s before the catch at line 262 silently keeps the previous frame — image rendering permanently lags the poll loop with zero user signal. The timeout also only SIGTERMs the direct child; an orphaned chafa (renderer SIGKILLed mid-render) loses that enforcement (chafa is CPU-bound and self-terminates, so impact is bounded).",
      "remediation": "Count consecutive chafa failures; after N (e.g. 3), drop to text mode or stop re-attempting for a cooldown and surface it in the banner ('image rendering disabled: chafa timing out')."
    },
    {
      "id": "REL-P2-03",
      "severity": "P2",
      "confidence": 75,
      "file": "bin/renderer.mjs",
      "line": "all process.stdout.write call sites (e.g. 230-247, 259-261); chafa maxBuffer at 257",
      "title": "No stdout backpressure handling; up to 32MB per frame buffered without drain",
      "detail": "Every write ignores the return value and nothing awaits 'drain'. A stalled consumer (herdr/tmux not reading the pty, or stdout redirected to a slow pipe) lets Node's internal buffer accumulate one kitty/symbols frame (capped at 32MB by maxBuffer) per tick — unbounded memory growth across ticks. In practice pty consumers rarely stall for long, hence P2.",
      "remediation": "Check the write() return for the large frame write; when false, skip further image frames until 'drain' fires (console/header writes are small and can continue)."
    },
    {
      "id": "REL-P2-04",
      "severity": "P2",
      "confidence": 80,
      "file": "bin/renderer.mjs",
      "line": "204-207",
      "title": "enqueue() swallows all painting errors permanently and invisibly",
      "detail": "`this.paintQueue.then(fn, () => {})` discards any synchronous throw from header()/renderConsole()/tick-painting code forever — no counter, no banner, no log. A persistent paint bug (e.g. from pathological terminal sizes) degrades the pane silently while the poll loop keeps running.",
      "remediation": "Replace the empty handler with one that increments a paintErrors counter and shows it in the banner after a threshold (mirroring the failures/banner pattern already used for agent-browser errors)."
    },
    {
      "id": "REL-P2-05",
      "severity": "P2",
      "confidence": 75,
      "file": "bin/renderer.mjs",
      "line": "319-327; shot path at 187-188",
      "title": "Screenshot tmp+rename pattern is safe single-process but races across duplicate panes in one workspace",
      "detail": "Within one renderer, screenshot→hash→rename is atomic and partial reads can't occur (verified design). But the tmp name (`shot-<ws>.png.tmp`) is shared by every renderer in the workspace, so if the open.sh lock race (REL-P1-01) or a manual pane spawn creates two renderers, renderer A can rename renderer B's in-progress write → corrupt PNG for chafa (handled: keep previous frame) and ENOENT on B's readFileSync (counted as agent-browser failure, eventually a misleading 'not responding' banner). Self-healing but noisy.",
      "remediation": "Make the tmp path unique per process (`shot-<ws>.<pid>.tmp`) — one-line change that removes the cross-process window entirely; keep the shared final path so close.sh cleanup still works (or have cleanup() unlink `shot-<ws>.*.tmp` too)."
    },
    {
      "id": "REL-P2-06",
      "severity": "P2",
      "confidence": 75,
      "file": "bin/renderer.mjs",
      "line": "122-168 (execFile children), 545-550 (crash path)",
      "title": "Renderer SIGKILL orphans in-flight agent-browser CLI / chafa children with no timeout enforcement",
      "detail": "The 10s/15s execFile timeouts are enforced by the parent; when the renderer is SIGKILLed (pane force-kill, herdr crash), up to 4 in-flight agent-browser CLI processes per tick plus a chafa lose their killer. chafa self-terminates; agent-browser CLI lifetime depends on the daemon socket behavior and could linger. Also: the crash path (549) intentionally lingers 10 minutes so the user can read the error — fine — but it never restores stdin raw mode when run() threw after setupInput(), so the dead pane swallows keystrokes in raw mode for those 10 minutes.",
      "remediation": "Low-cost hardening: pass `killSignal: 'SIGKILL'` is not enough (parent is dead) — instead ensure herdr kills the process group (pty), which it typically does; for the crash path, add `try { process.stdin.setRawMode(false); } catch {}` alongside the alt-screen restore."
    },
    {
      "id": "REL-P2-07",
      "severity": "P2",
      "confidence": 75,
      "file": "scripts/open.sh",
      "line": "47-48",
      "title": "Focus failure silently swallowed: pane dies between liveness check and focus → open appears to do nothing",
      "detail": "`pane_alive` succeeds, the pane dies, `herdr plugin pane focus` fails, `|| true` hides it, and the script exits 0 with a stale pidfile. The user pressed the keybinding and nothing happened, with no message. Next invocation heals it, but the first failure is invisible.",
      "remediation": "On focus failure, remove the pidfile and fall through to the pane-open branch instead of `|| true`."
    },
    {
      "id": "REL-P2-08",
      "severity": "P2",
      "confidence": 75,
      "file": "scripts/close.sh",
      "line": "34-46",
      "title": "Untracked-pane sweep silently skipped when node is absent from PATH",
      "detail": "The stray-pane sweep is gated on `command -v node`. In exactly the PATH-broken environments where panes most often go untracked (node missing is also why pane.sh fails), the sweep silently does nothing and close reports success — untracked Browser/Browse panes linger with their renderers polling agent-browser forever.",
      "remediation": "When node is missing and HERDR_WORKSPACE_ID is set, print a warning to stderr ('stray-pane sweep skipped: node not found') so the degradation is visible in `herdr plugin log list`."
    },
    {
      "id": "REL-P2-09",
      "severity": "P2",
      "confidence": 75,
      "file": "scripts/lib.sh:4 + scripts/open.sh:50-54",
      "line": "see file list",
      "title": "Missing herdr binary misreported as 'failed to open pane'; general PATH fragility for GUI-spawned shells",
      "detail": "If herdr isn't on PATH and HERDR_BIN_PATH is unset, pane_alive quietly returns false and the script dies at exit 4 with 'failed to open pane' — wrong root cause. Broader PATH assumption: the plugin expects node, agent-browser, chafa, carbonyl, cksum, and sh on the PATH of herdr-spawned non-interactive shells; nvm/fnm/homebrew installs are frequently absent there. pane.sh handles missing node gracefully; the renderer handles missing chafa gracefully; missing agent-browser is the silent one (REL-P1-04).",
      "remediation": "Add a `command -v \"$HERDR\"` preflight in open.sh/close.sh/browse.sh with a clear 'herdr CLI not found (set HERDR_BIN_PATH)' error."
    },
    {
      "id": "REL-P2-10",
      "severity": "P2",
      "confidence": 80,
      "file": "bin/renderer.mjs",
      "line": "210-215, 266-272",
      "title": "Terminals below ~5 rows paint garbage (negative/zero row addresses), no crash",
      "detail": "At rows < 5, imageRows goes negative (renderImage safely early-returns, and mapClickToPage guards imageRows<=0 — good), but renderConsole computes top = rows - consoleRows ≤ 0 and emits row addresses like ESC[0;1H/ESC[-1;1H, which terminals clamp to row 1, so console lines overpaint the header. truncate(s, 0) yields '…' (one char into zero columns). Cosmetic, self-correcting on resize; no crash or hang at any size (verified by code inspection — all loops bounded).",
      "remediation": "Clamp consoleRows/imageRows with Math.max(0/1, …) and skip renderConsole/renderBottom when rows < 6, painting a single 'terminal too small' line instead."
    }
  ],
  "residual_risks": [
    "P0: none found. No data-loss, security, or crash-in-normal-operation defects; the poll loop, enqueue serialization, tmp+rename screenshot handling, execFile timeouts (JS side), SIGTERM/SIGHUP/SIGINT handlers, and the idle backoff are all genuinely solid.",
    "HERDR_WORKSPACE_ID is interpolated unsanitized into state-dir file names (pane-id-, browse-ids-, open-lock-, shot-) and the session name — herdr is the trust boundary, but a value containing '/' or '..' would write outside the state dir. Consider tr -cd '[:alnum:]_-' at the lib.sh boundary.",
    "agent-browser upgrade mid-session: the renderer assumes the {success, data} JSON shape and data.sessions list; a breaking CLI change degrades to 'not responding' → detach → 'waiting for session' — graceful, but every tick still spawns up to 4 subprocesses against a broken CLI (bounded by 8x backoff).",
    "Stdout EIO if the pty master vanishes without a signal: no 'error' handler on process.stdout, so cleanup (alt-screen/kitty restore) would be skipped. EPIPE to pipes is silently swallowed by Node (verified on Node 24 — exit 0), and herdr normally signals the pane first (SIGHUP handled), so the window is narrow.",
    "The crash path's deliberate 600s linger (renderer.mjs:549) and pane.sh/browse-pane.sh's `sleep 600` keep dead panes resident; that's by design for readability but means a crashed pane holds its pty/slot for 10 minutes.",
    "Repo hygiene: a literal `~/.local/state/herdr/plugins/structupath.browser/pane-id-w2` directory is committed at the repo root — evidence some past run executed with HOME set to a literal unquoted '~'; harmless but should be deleted and investigated as a path-quoting slip."
  ],
  "testing_gaps": [
    "No multi-waiter lock-contention test — the existing stale-lock test (launchers.test.mjs) uses a single waiter; a two-waiter test would have caught the verified REL-P1-01 mutual-exclusion break.",
    "No test that selfCreated is cleared when the session dies and is recreated by someone else (REL-P1-02 ownership lapse).",
    "No test for pane/renderer behavior when the agent-browser binary is absent entirely (ENOENT), vs. present-but-session-absent — the two states are currently conflated (REL-P1-04).",
    "No tests exercise tick() failure transitions: failures counting, the 3-failure banner flip, detach/reattach, or consoleState carry-over across reattach.",
    "No test for chafa timeout/repeated-failure behavior (the 15s catch-and-keep-previous-frame path) or for renderImage when the screenshot is a corrupt/partial PNG.",
    "Nothing covers script-level hangs — there are no timeout mechanisms in the scripts to test yet (REL-P1-03)."
  ]
}
```