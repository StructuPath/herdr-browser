# Browser readiness assessment

## Engine decision

Keep the existing Chromium integrations. Current main already supports a
locally launched Chrome/Chromium (`l`), external CDP attach (`a`), shared
agent-browser sessions, and an optional separate Carbonyl browser. Adding an
Electron shell or maintaining a Chromium fork would duplicate the engine and
add packaging and update work without fixing the session and streaming bugs.

- Use **agent-browser** to share a coding agent's session.
- Use **local Chromium launch** for standalone browsing in the pane. Set
  `HERDR_BROWSER_LAUNCH=1` and, if discovery fails,
  `HERDR_BROWSER_CHROMIUM=/absolute/path/to/chrome`.
- Use **CDP attach** to watch an existing automation browser. Use observe-only
  mode when the pane should not forward user input.
- Use **Carbonyl** when full terminal-native interaction matters more than
  sharing the agent's session.

Upstream installation references: [agent-browser](https://agent-browser.dev/installation)
and [Carbonyl](https://github.com/fathyb/carbonyl). Agent-browser installs its
own Chrome engine; a second bundled distribution is unnecessary.

## Changes in this PR

- Preserve daemon configuration: injecting a 30-minute idle timeout into an
  existing agent-browser 0.33.2 session restarted its daemon and discarded its
  browser during a read-only stream-status request. Both launcher navigation
  and renderer commands now inherit the caller's settings unchanged.
- Register the frame listener before awaiting the WebSocket handshake.
- Recover to screenshot polling if a connected stream sends no image within
  five seconds; remove stale socket listeners and cancel the watchdog on exit.
- Add build, validation, prerequisite diagnostics, and mandatory real-browser
  checks. Real tests cover local Chromium lifecycle, streaming, navigation,
  console delivery, reconnect, and screenshot fallback without public sites.
- Limit test discovery to this checkout's `tests/` directory; Node 20 otherwise
  traverses hidden nested worktrees and runs unrelated, stale test copies.

## Next recommendations, in priority order

1. **Release compatibility matrix.** Exercise macOS and Linux, Node 22/24,
   supported agent-browser versions, and Kitty/symbol rendering in Herdr.
   Current CI has Node 20/22 but does not install agent-browser, so its passing
   status alone cannot prove shared-session integration. Adopting the strict
   integration command in hosted CI is a separate workflow change.
2. **CDP transport correctness.** HTTP discovery currently uses `node:http`
   even for an HTTPS input and assumes the local debugging port. Implement
   actual HTTPS discovery with transport tests before advertising secured
   remote HTTP discovery; use a verified browser WebSocket endpoint meanwhile.
3. **Long-session reliability.** Add soak tests for daemon restart, stalled
   streams after the first frame, rapid resize, multiple viewers, and reconnect
   during navigation. The new watchdog covers initial image delivery, not all
   possible later stalls.
4. **Interactive browser completeness.** Prioritize keyboard shortcuts,
   downloads, file upload, dialogs, and explicit target selection. Define
   behavior separately for owned and externally controlled browsers and prove
   each against a local fixture before adding UI controls.
5. **Recording across backends.** Recording currently requires agent-browser.
   Direct Chromium/CDP recording should clearly state its capture lifecycle
   and avoid altering externally owned browser contexts.

These are follow-up milestones, not claims that this plugin is a full browser
replacement. The current PR addresses startup verification and the reproduced
shared-session failure while retaining the existing engine architecture.
