# herdr-browser

A drivable browser pane for [Herdr](https://herdr.dev), built around
[agent-browser](https://github.com/vercel-labs/agent-browser).

When a coding agent drives Chrome in one pane, herdr-browser gives you a live,
human-visible view of that same session in another. You can inspect the page,
watch console output and page errors, click real browser coordinates, type,
scroll, navigate, and record the flow without leaving Herdr.

## Highlights

- **Shared agent sessions** — one isolated browser session per Herdr workspace.
- **Live push streaming** — frames, URL/title changes, console messages, and
  page errors arrive over WebSocket, with transparent polling fallback.
- **Pane-aware layout** — the browser viewport fits the pane without stretching
  or changing its responsive width; the console opens only when output exists.
- **Real interaction** — clicks use Chrome mouse events rather than DOM selector
  guesses; keyboard input, history, reload, and wheel scrolling are supported.
- **Adaptive rendering** — Kitty graphics when available, ANSI symbols through
  chafa otherwise, and a text-only last resort.
- **Built-in recording** — capture the workspace session as WebM.
- **Localhost integration** — Cmd/Ctrl+click a local development URL in Herdr to
  open it in the workspace browser pane.

## Requirements

| Component | Requirement | Notes |
| --- | --- | --- |
| Herdr | `>= 0.7.0` | Tested with Herdr 0.7.4 |
| Node.js | `>= 20` | Node 22+ enables live WebSocket streaming |
| agent-browser | Required | Tested with agent-browser 0.28.x |
| chafa | Optional | ANSI rendering and streamed JPEGs in Kitty mode |
| carbonyl | Optional | Only required for the separate interactive Browse action |

Install the browser engine:

```sh
npm install -g agent-browser
agent-browser install
```

For ANSI image rendering on macOS:

```sh
brew install chafa
```

## Install

```sh
herdr plugin install StructuPath/herdr-browser
```

For development from a local checkout:

```sh
git clone https://github.com/StructuPath/herdr-browser
cd herdr-browser
herdr plugin link .
```

## Quick start

Open the viewer from the CLI:

```sh
herdr plugin action invoke structupath.browser.open
```

With no URL, **Open** creates the pane without creating or navigating a browser
session. Start agent-browser with the session name shown in the pane header:

```sh
# Replace this example with the exact session shown in the pane header.
agent-browser --session herdr-ws-w123456 open http://localhost:3000
```

You can also press `u` inside the pane and enter a URL, or Cmd/Ctrl+click a
localhost URL printed in another Herdr pane.

### Optional keybinding

Herdr plugins do not install default keybindings. Add one to
`~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "structupath.browser.open"
description = "browser pane"
```

## Actions

The plugin registers five actions:

| Action | ID | Behavior |
| --- | --- | --- |
| Open browser pane | `structupath.browser.open` | Attach view-only with no URL, or navigate when invoked by a link handler |
| Close browser session and pane | `structupath.browser.close` | Close every browser pane in the workspace and end its session |
| Browse interactively | `structupath.browser.browse` | Open a separate Carbonyl browser in a zoomed pane |
| Start session recording | `structupath.browser.record-start` | Begin WebM recording for the workspace session |
| Stop session recording | `structupath.browser.record-stop` | Finish the active recording |

The localhost link handler accepts only `http://` or `https://` URLs for
`localhost`, `127.0.0.1`, or `[::1]`. A modified click opens the URL in the
browser pane; an ordinary click keeps Herdr's default behavior.

### Interactive Browse action

The Browse action uses [Carbonyl](https://github.com/fathyb/carbonyl), a
separate terminal-rendered Chromium with native mouse and keyboard support:

```sh
npm install -g carbonyl@next
```

Carbonyl does **not** share the coding agent's browser session. Use the
standard Open action whenever you need to observe or drive the same session as
your coding agent.

## Viewer controls

Use these controls to drive the shared session directly:

| Input | Action |
| --- | --- |
| `u` | Open the address prompt; `https://` is assumed when omitted |
| Click the screenshot | Send real Chrome mouse move/down/up events at that page coordinate |
| `i` | Type into the currently focused page element |
| `b` / `f` | Navigate backward / forward |
| `r` | Reload |
| `j` / `k` | Scroll down / up |
| Space | Scroll down |
| Mouse wheel | Scroll the page |
| `Esc` | Cancel the active prompt |
| `q` | Close the viewer pane |

Clicks are mapped through the rendered-frame geometry to page pixels, so they
work with overlays, canvas content, and shadow DOM. Live sessions usually
repaint immediately; polling fallback can take up to the configured interval.

## Rendering and streaming

### Automatic mode selection

The renderer probes the terminal at startup and selects the strongest usable
mode:

| Mode | Behavior |
| --- | --- |
| `kitty` | Real-pixel graphics; polling PNGs are transmitted directly |
| `symbols` | Screenshot rendered as ANSI symbols through chafa |
| `text` | URL, title, status, and console output without an image |

Live-stream frames are JPEG. Kitty terminals therefore use chafa for live
frames; when chafa is unavailable, the renderer keeps the direct-PNG polling
path instead of sending an unsupported image format.

To enable Herdr's experimental Kitty graphics support in Ghostty, Kitty, or
WezTerm:

```toml
# ~/.config/herdr/config.toml
[experimental]
kitty_graphics = true
```

Then reload Herdr:

```sh
herdr server reload-config
```

### Live stream with polling fallback

On Node 22+ with a compatible agent-browser, the pane connects to the local
session stream. Frames arrive only when the page changes, while the polling
loop becomes a low-frequency liveness check.

The pane falls back automatically when WebSocket support is unavailable, the
stream disconnects, or the selected renderer cannot display streamed JPEGs.
No feature flag is required.

### Pane fitting

On attach and pane resize, herdr-browser preserves the session's current
viewport width—and therefore its responsive breakpoint—while fitting only the
height to the pane's image area. The frame fills that area without stretching.

On a quiet page, the image uses all rows between the header and controls. The
console region appears only after a console message or page error arrives; the
viewport then refits to the remaining image area.

## Session model

By default, each Herdr workspace uses:

```text
herdr-ws-<workspace-id>
```

This prevents browser state from leaking between workspaces. The exact session
name appears in the viewer header.

- Opening the pane without a URL does not create a browser session.
- A session that already existed remains owned by the agent or caller.
- A session created from the viewer's `u` prompt is owned by that viewer and is
  closed with it so the browser daemon is not leaked.
- The **Close** action always ends the workspace session and closes its browser
  panes.
- Plugin-created browser daemons default to a 30-minute idle timeout.

To watch a differently named agent-browser session, write its name to the
plugin configuration directory:

```sh
echo "my-agent-session" \
  > "$(herdr plugin config-dir structupath.browser)/session"
```

## Recording

Start and stop recording through the two recording actions. Files are written
to:

```text
<Herdr plugin state>/recordings/herdr-ws-<id>-YYYYMMDD-HHMMSS.webm
```

Starting a recording creates a fresh browser context: the page reloads, while
cookies and localStorage are preserved. Start recording before the flow you
want to capture. Recordings persist until you delete them.

## Configuration

Plugin config files contain one value on their first line:

| File | Values | Default | Purpose |
| --- | --- | --- | --- |
| `session` | Session name | `herdr-ws-<workspace-id>` | Watch a different agent-browser session |
| `render` | `kitty`, `symbols`, `text` | Automatic probe | Force a rendering mode |

Equivalent environment controls:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_BROWSER_SESSION` | Workspace session | Override the watched session |
| `HERDR_BROWSER_RENDER` | Automatic probe | Override the rendering mode |
| `HERDR_BROWSER_INTERVAL_MS` | `1000` | Polling interval; clamped to safe bounds |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | `1800000` | Idle timeout for plugin-created browser daemons |

Environment variables take precedence over config files.

## Security and privacy

- Navigation accepts only `http://` and `https://` URLs and rejects embedded
  credentials and flag-like values.
- Workspace identifiers are sanitized before they are used in state paths.
- Polling frames are cached as PNG; streamed frames are cached as JPEG. Frame
  files are mode `0600` and removed when the pane exits.
- WebM recordings are intentionally retained under the plugin state directory.
- Browser sessions are a trusted local boundary: any local process that knows a
  session name can drive it, including authenticated pages.

If an agent browses sensitive or authenticated content, that content is visible
in the pane and briefly present in its cached frame. Treat screen sharing and
recordings accordingly, and use the Close action when the session is no longer
needed.

## Troubleshooting

- **`agent-browser is not installed`** — run
  `npm install -g agent-browser && agent-browser install`.
- **`session … is not running`** — open a URL with `u`, click a localhost link,
  or start agent-browser with the session shown in the pane header.
- **Text-only mode** — install chafa or enable Kitty graphics in a compatible
  outer terminal.
- **No image or garbled symbols** — force symbols mode:
  `echo symbols > "$(herdr plugin config-dir structupath.browser)/render"`.
- **Space below the image** — console output has opened the console region.
  Pages that have emitted no console output automatically give those rows to
  the browser.
- **Changes are not visible after updating a linked plugin** — close and reopen
  the Browser pane so its renderer process loads the new code.
- **Plugin action failures** — inspect:
  `herdr plugin log list --plugin structupath.browser`.

## Development

```sh
git clone https://github.com/StructuPath/herdr-browser
cd herdr-browser
npm test
shellcheck scripts/*.sh
herdr plugin link .
```

`npm test` includes unit, launcher, security, rendering, input, recording, and
live-stream coverage. The real agent-browser integration test skips when its
engine is unavailable.

## License

MIT © StructuPath
