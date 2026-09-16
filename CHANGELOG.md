# Changelog

## Unreleased

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
