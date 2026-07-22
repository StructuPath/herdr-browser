# Task for ce-best-practices-researcher

Research capability-upgrade opportunities for the herdr-browser plugin at /Users/vics/dev/structupath/herdr-browser (read README.md, herdr-plugin.toml, bin/renderer.mjs, scripts/*.sh first so suggestions are grounded in what exists). Then research externally: (1) agent-browser (vercel-labs/agent-browser on GitHub) — current release version vs the tested 0.28.x; new commands/features since then that a live-viewer pane could exploit (e.g. screencast/streaming, CDP access, network logs, accessibility snapshots, trace recording, headed mode, session pool); (2) chafa — optimal flags for high-quality fast terminal rendering (symbols, dither, colors, size) and any newer canvas modes; (3) Kitty graphics protocol — best practices for animation/redraw (image IDs, placement, delete semantics, chunked transmission limits); (4) Herdr plugin API — the project is a plugin for Herdr (herdr.dev, tested against 0.7.4): what capabilities does the plugin manifest/pane protocol expose (actions, panes, link_handlers exist — what about pane input, status lines, mouse passthrough, config)? Check herdr docs/changelog for versions > 0.7.4. (5) carbonyl — current state, flags worth using for the browse pane. Deliver: a ranked list of concrete capability upgrades, each with evidence (link/command), expected user value, and rough implementation cost. Do NOT edit files — report only.

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