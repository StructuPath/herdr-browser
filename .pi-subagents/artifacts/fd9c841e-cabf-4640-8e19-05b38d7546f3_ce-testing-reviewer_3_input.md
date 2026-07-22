# Task for ce-testing-reviewer

Audit test coverage of /Users/vics/dev/structupath/herdr-browser. Context: Herdr terminal plugin. bin/renderer.mjs (~551 lines) — polling TUI renderer with click-mapping geometry, address bar, escape sanitization, poll backoff, session ownership; scripts/*.sh — open/close/browse/pane/lib; tests/ has renderer.test.mjs, launchers.test.mjs, pattern.test.mjs (57 tests, all passing via `npm test`, node:test runner). Read bin/renderer.mjs and every script and every test file fully. Map which functions/branches are tested vs untested. Identify: (1) high-risk untested paths (geometry edge cases, sanitize completeness, shell script logic tested only via launchers.test?), (2) weak assertions that would pass despite bugs, (3) missing integration-ish tests that are feasible with node:test (e.g. spawning renderer against a stub agent-browser binary on PATH), (4) brittle tests coupled to implementation. Deliver a prioritized list of specific test cases to add (name + what it asserts + which file), and note any production-code seams needed to make them testable. Do NOT edit files — report only.

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