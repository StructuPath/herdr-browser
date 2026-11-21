# Changelog

## Unreleased

- Add bounded expected/actual values and selectors to failed QA assertions,
  redact literal fill values from text evidence, identify invalid steps by index
  and type, and name malformed scenario files without echoing their contents.
- Add an on-demand page text view: press `s` for the accessibility-tree
  snapshot (interactive elements carry `@eN` refs), `n` for the full recent
  request table, and `d` for a ref-normalized diff against the last snapshot.
  Works on both backends (agent-browser `snapshot`/`network requests`, CDP
  `Accessibility`/`Network`); any page-driving action dismisses it.
- Page through long text views: `j`/`k` by line, Space/`b` or PgDn/PgUp by
  page, `g`/`G` to the top/bottom (also in observe-only mode); Esc or the
  view's own key closes it. The footer shows the position.
- Ignore clicks and wheel events while a text view covers the screenshot, so
  they no longer reach hidden page elements. Drop a stale snapshot or diff on
  navigation in live-stream and attach modes too, and forget the last snapshot
  when switching browsers.
- Help and banners: `t:tabs` is listed only where `t` works, `i` is labeled
  `i:type` everywhere, `t`/`s`/`n`/`d` while unattached show the same waiting
  advice as the pane, link hints say Ctrl+click off macOS, and the chafa install
  hint (pane and `npm run doctor`) matches the platform.
- Select attached or locally launched browser tabs explicitly from a title/URL
  picker. Clear stale frames and pending input when the selected tab closes;
  require another selection before forwarding input.
- Preserve whitespace, Unicode, tabs, and newlines in the text prompt with
  bracketed paste. Confirm insertion separately without sending Enter to the page.

## 0.8.0

- Add declarative saved browser QA scenarios with isolated desktop/mobile
  sessions, literal assertions, screenshots, and bounded error/request evidence.
- Record exact Git HEAD and dirty state plus observed changes during each run;
  expose typed local JSON summaries for Console and PR workflows.
- Add scenario validation, bounded timeouts and cleanup, private output, and
  real Chromium localhost regression coverage. Existing pane actions are unchanged.

## 0.7.0

- Shared agent-browser sessions, local Chromium launch, CDP attach, streaming,
  failed-request visibility, and readiness/build diagnostics.
