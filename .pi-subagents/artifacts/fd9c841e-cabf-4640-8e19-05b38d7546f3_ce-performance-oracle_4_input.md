# Task for ce-performance-oracle

Analyze /Users/vics/dev/structupath/herdr-browser for performance. Context: Herdr terminal plugin; bin/renderer.mjs polls agent-browser for a full-page screenshot + console on an adaptive interval (backs off on idle, caps at 8x), shells out to chafa per frame for ANSI rendering or emits Kitty graphics protocol chunks, parses PNG headers, streams console text, handles SGR mouse input. scripts/*.sh are launch paths. Read all files. Look for: wasted work per poll cycle (e.g. re-fetching unchanged screenshots — is there a hash/ETag skip? re-running chafa on identical frames?), terminal write amplification (full-screen redraw vs diff), base64 chunk sizing for Kitty protocol, JSON parse cost of console tail, spawn overhead of chafa vs keeping it warm, PNG size vs requested viewport, memory growth (console buffer, image cache), and wakeups while pane is unfocused. Report concrete, measured-reasoning findings (P0/P1/P2) with file:line and the expected win. Do NOT edit files — report only.

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