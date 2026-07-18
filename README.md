# herdr-browser

A driveable browser pane for [Herdr](https://herdr.dev). Open a URL from an
action or a Ctrl+click on a localhost link, and get a live view of a headless
Chrome session inside a Herdr pane: screenshot, URL/title, and streaming
console output. Screenshots render as real pixels via the Kitty graphics
protocol, with an ANSI fallback everywhere else.

Built for the agent workflow: when a coding agent drives
[agent-browser](https://github.com/vercel-labs/agent-browser) in one pane, this
plugin gives you a live human-visible view of the same browser session in
another — without touching the agent's page state.

## Install

```sh
herdr plugin install StructuPath/herdr-browser
```

### Prerequisites

- **agent-browser** — the browser engine (daemon-backed headless Chrome):

  ```sh
  npm install -g agent-browser && agent-browser install
  ```

- **chafa** — renders screenshots into the terminal (optional but strongly
  recommended; without it the pane runs text-only):

  ```sh
  brew install chafa        # macOS
  ```

- **Node.js >= 20** on your PATH (the pane renderer).

Tested against herdr 0.7.4 and agent-browser 0.28.x.

## Usage

The plugin ships two actions (Herdr plugins cannot ship default keybindings —
add your own):

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "structupath.browser.open"
description = "browser pane"
```

- **Open** (`structupath.browser.open`) — with no URL (the keybinding/invoke
  path), attaches the pane **view-only** to this workspace's browser session
  without navigating it. With a URL (the link-click path), navigates first.
- **Close** (`structupath.browser.close`) — closes the pane and ends this
  workspace's browser session.
- **Localhost links** — a modified click (Cmd/Ctrl+click) on any
  `http://localhost:PORT`, `127.0.0.1`, or `[::1]` URL printed in a Herdr pane
  opens it in the browser pane instead of your system browser. Plain clicks
  keep their default behavior.
- **Browse** (`structupath.browser.browse`) — an *interactive* browser pane
  via [carbonyl](https://github.com/fathyb/carbonyl) (Chromium rendered into
  the terminal: mouse, scrolling, typing all work). With no URL it prompts —
  an address bar in a pane. Requires `npm install -g carbonyl`. This is a
  personal browser with its own Chromium; it does not share the agent's
  session — use the viewer pane (Open) for that.

## Real-pixel screenshots (optional)

By default screenshots render as ANSI half-blocks. For real pixels, enable
Herdr's experimental Kitty graphics support (requires a Kitty-graphics-capable
outer terminal — Ghostty, Kitty, WezTerm):

```toml
# ~/.config/herdr/config.toml
[experimental]
kitty_graphics = true
```

Then `herdr server reload-config`. The renderer probes for support at pane
start and picks the best mode automatically; override with the `render` config
(see below) or `HERDR_BROWSER_RENDER=kitty|symbols|text`.

## The session model

Each Herdr workspace gets its own browser session, named `herdr-ws-<id>`. The
pane is a **passive viewer**: it never navigates, never clears the console,
and never kills the session — closing the pane leaves the browser running for
whatever agent is using it. Cleanup is the Close action, or agent-browser's
idle timeout (`AGENT_BROWSER_IDLE_TIMEOUT_MS`, disabled by default).

To watch the session your coding agent is actually using, either tell the
agent to use the workspace session:

> run agent-browser with `--session herdr-ws-<id>` (the pane header shows the
> exact name)

or point the pane at the agent's session by writing the session name to the
plugin config:

```sh
echo "my-agents-session" > "$(herdr plugin config-dir structupath.browser)/session"
```

Config files (one value per line, in the plugin config dir):

| File      | Values                    | Meaning                          |
|-----------|---------------------------|----------------------------------|
| `session` | any agent-browser session | watch this session instead       |
| `render`  | `kitty` `symbols` `text`  | force a render mode              |

## Privacy note

The pane caches the latest screenshot (and nothing else) as a PNG in Herdr's
plugin state dir, `chmod 600`, deleted when the pane closes. If your agent
browses authenticated pages, that content is visible in the pane and briefly
on disk — treat screen shares accordingly.

## Troubleshooting

- **Pane says "session … is not running"** — nothing has started that
  workspace's browser yet. Invoke Open with a URL, click a localhost link, or
  have your agent use the session name in the header.
- **Text-only mode** — chafa isn't installed (`brew install chafa`).
- **No image, garbled block art** — your outer terminal doesn't support Kitty
  graphics; the renderer should fall back to `symbols` automatically. Force it:
  `echo symbols > "$(herdr plugin config-dir structupath.browser)/render"`.
- **Plugin logs** — `herdr plugin log list --plugin structupath.browser`.

## Development

```sh
git clone https://github.com/StructuPath/herdr-browser
herdr plugin link ./herdr-browser
npm test
```

MIT © StructuPath
