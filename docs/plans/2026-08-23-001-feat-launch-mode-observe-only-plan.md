---
title: "feat: Chromium launch mode, observe-only input, and the backend/render-mode split"
type: feat
date: 2026-08-23
---

# feat: Chromium launch mode, observe-only input, and the backend/render-mode split

## Summary

Three changes that close the gap between the pane's design and what actually
ran, then remove its last external dependency. First, the backend decision
(attach vs agent-browser) moves out of `this.mode`, which `run()` was
overwriting with the render mode — the configured-endpoint attach path was
unreachable in the real binary. Second, two follow-ups deferred by the CDP
attach plan land: the `t` key drives the already-implemented `cycleTarget()`,
and `o` toggles observe-only, dropping all pane input at the pane so watching
a live automation run cannot perturb it. Third, launch mode: `l` starts a
local Chromium the pane owns and attaches to it, making the pane usable with
zero pre-existing engines.

## Requirements

**Backend split**

- B1. `this.backend` carries `attach`/`agent-browser`; `this.mode` is
  render-only (`kitty`/`symbols`/`text`, `null` until `run()` probes). Every
  former backend check on `this.mode` reads `this.backend`.
- B2. The header shows `attach:<host:port>` (never the capability-token path)
  while attached, and the session name otherwise — the quick start tells
  users to copy it from there.
- B3. A regression test exercises `tick()` *after* a render-mode assignment,
  the combination the old tests never covered.

**Observe-only (o)**

- O1. While on, clicks, wheel events, page-affecting keys (`u i b f r j k`
  space), and Cmd+click navigate handoffs are dropped at the pane; a banner
  says why and the help line shows the state. Nothing is sent to the
  observed browser when toggling — it is a pane-side latch.
- O2. The toggle itself, pane-view keys (`t`), `a`, `l`, and `q` stay
  reachable. Works in both backends.

**Target cycling (t)**

- T1. `t` calls the attach backend's `cycleTarget()`; a single-target
  browser reports "no other page targets" instead of doing nothing.

**Launch mode (l)**

- L1. `l` finds a browser (`HERDR_BROWSER_CHROMIUM` env / `chromium` config
  first, then PATH names and macOS app bundles), spawns it with
  `--remote-debugging-port=0` and a per-workspace profile under plugin
  state, reads the bound port from `DevToolsActivePort`, and attaches
  through the normal attach path. Headless by default;
  `HERDR_BROWSER_LAUNCH_HEADED=1` for a window; `--no-sandbox` only as root.
- L2. Ownership is the deliberate difference from plain attach: quit or
  attaching elsewhere kills the launched browser — never leak a headless
  Chrome. Refuse before spawning on Node < 22.
- L3. The unattached key gate admits `a` and `l` (it swallowed `a`, making
  the documented attach key unreachable exactly when it was the answer).
- L4. A real-browser integration test (skipped where no Chromium or Node <
  22) drives launch → attach → navigate → frame → console feed → child kill.

## Also fixed en route

- The 294cade merge kept both sides of the 34d1559 fix in `navigate()`
  (baseline flag cleared immediately) and both drafts of the README's
  failure-feed paragraph; both restored to the fixed versions.
- CI's Node setup step illegally combined `uses` with `run`, so no CI step
  had ever executed; the workflow now runs tests on a Node 20/22 matrix.
- Firefox endpoints fail `Page.startScreencast` with a named banner instead
  of a raw protocol error (deferred item from the attach plan).
