# Task for ce-reliability-reviewer

Review /Users/vics/dev/structupath/herdr-browser for production reliability and failure modes. Context: Herdr terminal plugin; bin/renderer.mjs is a long-running TUI process that polls agent-browser (external daemon, may be absent/crash/upgrade mid-session), spawns chafa per screenshot, writes to stdout, handles SIGTERM/SIGINT/resize; scripts/*.sh launch actions and panes; sessions are per-workspace with a lock to serialize concurrent opens. Read every file. Examine: what happens when agent-browser isn't installed, daemon dies mid-poll, session is killed externally, chafa is missing/slow/hangs, screenshot file is partially written when read, terminal shrinks below usable size, stdout backpressure, unhandled promise rejections, timers keeping the event loop alive on shutdown, lock-file staleness (open.sh workspace lock — crash between acquire/release?), zombie processes after pane kill, and PATH assumptions in scripts. 57 tests currently pass (npm test). Report P0/P1/P2 findings with file:line and concrete remediation. Do NOT edit files — report only.

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