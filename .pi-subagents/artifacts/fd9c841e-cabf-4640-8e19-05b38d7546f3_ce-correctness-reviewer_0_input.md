# Task for ce-correctness-reviewer

Review /Users/vics/dev/structupath/herdr-browser for logic errors, edge cases, state bugs, and error-propagation failures. Context: herdr-browser is a Herdr terminal-multiplexer plugin — a driveable browser pane. bin/renderer.mjs (~551 lines, Node>=20, ES module) is a TUI renderer that polls agent-browser (daemon-backed headless Chrome) for screenshots/URL/title/console output and renders into the terminal via Kitty graphics or ANSI half-blocks (via chafa), maps mouse clicks back to page coordinates, has an address bar, scroll, history nav. scripts/*.sh implement plugin actions (open.sh, close.sh, browse.sh, browse-pane.sh, pane.sh, lib.sh shared helpers). herdr-plugin.toml is the manifest. tests/*.mjs are node:test suites (57 tests, currently passing — run `npm test` to confirm). Read every file fully (use offset/limit reads). Hunt: off-by-one geometry math in click mapping, race conditions between poll loop and user input, partial/corrupt PNG handling, session-name derivation mismatches between bash and JS, process cleanup on signals, integer parsing of env vars, escape-sequence sanitization completeness. Report concrete findings as P0 (correctness bug users will hit), P1 (edge case), P2 (nit), each with file:line, a one-line explanation, and a suggested fix. Do NOT edit any files — report only.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```