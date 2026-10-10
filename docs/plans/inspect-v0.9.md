# Browser 0.9 — "Inspect": read the page as text, not pixels

## Problem

The pane is pixel-only: screenshots, a console strip, and a failed-request feed.
A human watching an agent — or a text-only terminal — cannot *read* the page,
inspect an element, see the full request log, or tell what an agent's last
action changed. Competitors (Playwright CLI, Stagehand, Browser Use) all ship an
accessibility-tree snapshot; the engine already does too (`agent-browser
snapshot`, `find`, `network requests`, `diff snapshot`, `get box/styles/text`,
`highlight`). The pane uses none of them.

## Decision

Add an on-demand **page text view** that renders in the screenshot region, with
three sources, uniform across both backends (agent-browser + CDP attach/launch).

1. **Snapshot (a11y tree)** — key `s`. Role/name tree with `@eN` refs on
   interactive elements (Playwright CLI cherry-pick; engine `snapshot` /
   CDP `Accessibility.getFullAXTree`).
2. **Network requests** — key `n`. Bounded `METHOD STATUS TYPE URL` rows, not
   just failures (DevTools / `network requests` cherry-pick).
3. **Snapshot diff** — key `d`. Ref-normalized line diff vs the last snapshot:
   "what did the agent just change?" (new pane differentiator; `diff snapshot`).

Any page-driving action (navigate/reload/back/forward/scroll/click/type) or
re-pressing the active key returns to the screenshot.

## Contract

New pure module `bin/page-text.mjs` (unit-testable, no browser):

```js
formatAxNodes(nodes)         -> { title, lines }   // CDP AX node list -> indented role/name + @eN refs
parseAgentSnapshot(text)     -> { title, lines }   // agent-browser `snapshot -i -c` text
formatRequests(rows)         -> { title, lines }   // [{method,status,type,url}] -> rows
parseAgentRequests(text)     -> { title, lines }   // agent-browser `network requests` text
diffSnapshot(prev, next)     -> { title, lines }   // @eN refs stripped, +/- line diff
```

Both backends expose identical adapter methods (renderer `typeof`-guards absence):

```js
snapshotText()    -> Promise<{ title, lines }>
networkRequests() -> Promise<{ title, lines }>
```

- `bin/cdp.mjs` `makeCdpBrowser`: `Accessibility.enable` + `Accessibility.getFullAXTree`
  (tree via `childIds`) and `Network.enable` + `requestWillBeSent` /
  `responseReceived` / `loadingFailed` (bounded ring by `requestId`).
- `bin/renderer.mjs` `makeBrowser`: `snapshot -i -c` and `network requests`.

## Renderer integration

- `this.textView = null | { mode: 'snapshot'|'network'|'diff', title, lines }`.
- `this.lastSnapshot = null | string[]`.
- `s`/`n` fetch + set `textView`; `d` re-snapshots and diffs via `diffSnapshot`.
- Text view paints in the image region (header/controls/console unchanged);
  `renderBottom()` help gains `s/n/d`.

## Checks

- `npm run build`, `npm test` green; new `page-text.test.mjs` + `cdp.test.mjs` +
  `renderer.test.mjs` cases using existing local fixtures/test doubles.
- Manual: `s`/`n`/`d` in Herdr against a local page, both backends.
- README viewer-controls + highlights + CHANGELOG entry.

## Non-goals (this loop)

LLM-powered act/extract (model dependency), full DevTools network panel,
second renderer engine, emulation on attached sessions, full-page capture.
