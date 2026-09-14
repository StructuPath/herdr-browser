# Repeatable browser QA

Browser 0.8 adds saved desktop/mobile scenarios backed by the installed
`agent-browser` CLI. Each viewport gets a new browser session; the runner
collects assertion outcomes, viewport screenshots, console errors, page errors,
and failed HTTP requests in a private evidence directory. No Herdr session is
needed for this standalone command.

## First run

Requirements: Node.js 20+, Git with a committed SHA-1 HEAD, agent-browser
0.33.0+, and its installed Chromium engine. Tested with agent-browser 0.33.2.

```sh
npm install -g agent-browser
agent-browser install
```

Copy [the example scenario](../examples/qa.scenario.json) into the application
repository as `.herdr-browser-qa.json`. Set the expected heading and any other
checks to match the app. Commit the scenario and app changes to produce clean
commit-bound evidence. Start the app's development server yourself; QA does not
execute project scripts or start servers.

From the Browser checkout:

```sh
npm run qa -- check --config /path/to/app/.herdr-browser-qa.json
npm run qa -- run --config /path/to/app/.herdr-browser-qa.json \
  --repo /path/to/app --base-url http://localhost:3000 \
  --output /private/tmp/my-app-qa-run --json
```

The output directory must not exist yet, its parent must exist, and it must be
outside the tested repository. Omit `--output` to create a private temporary
directory. Each run prints its result location. `--json` prints the result as
one JSON object, with an additional absolute `resultPath` for local consumers.
The saved `result.json` contains the same evidence without that absolute path.
Exit 0 means all requested viewports passed and cleanup succeeded; exit 1 means
a failed run (including failed engine preflight); exit 2 means invalid command,
configuration, repository, or output setup.

## Scenario contract

The JSON file requires `schemaVersion: 1`, a `name`, HTTP(S) `baseUrl`,
`viewports`, and `steps`. Unknown fields and step types are refused. The first
step must be `navigate`. A viewport is `{ "name": "desktop", "width": 1440,
"height": 900 }`; names must be unique lowercase slugs. All steps run in order
for every viewport; the first failed step stops that viewport, then the runner
attempts a final screenshot, telemetry, and cleanup before the next viewport.

| Step `type` | Other fields | Check or behavior |
| --- | --- | --- |
| `navigate` | `path` | Open `/path` on the configured base origin |
| `click` | `selector` | Click a CSS/engine selector |
| `fill` | `selector`, `value` | Replace an input's text with fixture data |
| `waitFor` | `selector` | Wait for the selected element to be visible |
| `assertVisible` | `selector` | Require a visible element |
| `assertText` | `selector`, `contains` | Require an element's text to contain the literal text |
| `assertTitle` | `contains` | Require the page title to contain literal text |
| `assertUrl` | `contains` | Require the current URL to contain literal text |
| `screenshot` | `name` | Save the current viewport as a named PNG |

The runner always attempts a final viewport screenshot, including on assertion
failure. Screenshots use CSS viewport sizes, not full-page captures. Mobile
means a narrow viewport; it does not emulate touch input, device scale, mobile
user agent, or a physical device. Screenshot capture alone does not establish
visual correctness or accessibility compliance.

Limits: 64 KiB config, 1–4 viewports, widths 320–1920, heights 240–1600,
1–40 steps, and 10 MiB per screenshot. `timeoutMs` defaults to 10000 (range
100–30000); `runTimeoutMs` defaults to 120000 (range 1000–300000), plus bounded
cleanup. Each command's captured output is limited to 2 MiB; each telemetry
category is limited to 100 entries. Exceeding a telemetry bound fails evidence
collection rather than silently dropping observations. Assertions are immediate;
use `waitFor` after transitions before asserting their result.
The final JSON is capped at 1 MiB. If raw telemetry would exceed that cap, the
runner removes it, marks the run incomplete and failed, and retains counts and
artifact references. Configuration must be a regular file; symlinks, devices,
and pipes are rejected. Git metadata ignores inherited repository-routing
environment variables and disables fsmonitor/external diff helpers.

`failOnConsoleError`, `failOnPageError`, and `failOnFailedRequest` default to
`true`; an explicit `false` records that category without making it fail the
run. HTTP 4xx/5xx responses are failed requests. Some engine versions expose
no-response requests without distinguishing a transport failure from a still
pending request; these are separately counted as `unresolvedRequests`, and also
fail the run when `failOnFailedRequest` is true. Long-lived requests may need an
explicit project decision about that setting. Network capture is an observation
window, not proof of complete network coverage.

No arbitrary JavaScript, `eval`, shell commands, uploaded files, persistent
profiles, saved authentication, or browser attach settings are accepted in the
scenario. CLI operands cannot begin with `-`. The engine uses an explicit empty
config and does not inherit agent-browser sessions, providers, extensions,
restore state, init scripts, or generic credential environment variables.
`AGENT_BROWSER_EXECUTABLE_PATH` remains available to select local Chromium.

## Evidence and Console/PR use

`result.json` has `schemaVersion: 1`, `kind: "herdr-browser-qa"`, unique `runId`,
`status` (`passed` or `failed`), start/end ISO timestamps, the resolved scenario
name and SHA-256, engine version, and:

- `scenario.policy`: the three resolved `failOn*` booleans. A passing run with
  a relaxed policy means only its configured criteria passed. Strict handoff
  consumers should require all three booleans to be `true` and zero error counts.
- `git.commit`, `git.branch`, and `git.dirty`: the tested repository's observed
  start state. Dirty runs are permitted but visibly labeled.
- `git.changedDuringRun`: a comparison of start/end HEAD, branch, status, and
  tracked diff. A detected change fails the overall result. This comparison
  does not detect temporary changes reverted before completion or changes to
  the contents of already-untracked files. Dirty evidence is not clean-commit
  verification.
- `summary`: requested `viewports`, `passed`/`failed` viewport counts, attempted
  `assertions`, and `consoleErrors`, `pageErrors`, `failedRequests` counts.
- `runs[]`: viewport geometry, status, indexed step outcomes, error details,
  bounded telemetry, unresolved request count, and artifact metadata. Each
  artifact records a relative path, byte count, and SHA-256.
- `cleanup.status`: `passed` or `failed`. Failed cleanup fails the result.

The Git record does **not** prove the served app was built from that commit.
Run the server from the intended checkout and review its build/deployment
provenance separately. Evidence is ordinary editable local JSON, not signed
attestation, an approval receipt, or permission to merge/deploy.

Console consumers may read the typed summary and link local artifacts. PR
consumers should match `git.commit` to the proposed head and require
`dirty === false`, `changedDuringRun === false`, passed status, complete
viewport counts, and successful cleanup before describing a clean QA run.
Never interpolate raw browser output into executable commands.

The output directory is `0700`; result and screenshots are `0600`. Console/page
messages and screenshots can contain sensitive app data. Network URLs omit
credentials, query strings, and fragments, but paths and messages can still
contain secrets. Review artifacts before sharing; do not commit them by default.
Use fixture accounts and non-sensitive form values. Browser interactions can
submit forms or navigate away through the app; this is not an OS sandbox or
network containment boundary.

Only the newly generated session is closed, never a shared or attached browser.
SIGINT/SIGTERM request bounded cleanup and write failed evidence. A force kill
or host crash cannot guarantee evidence publication or cleanup; sessions have a
short idle timeout as a backstop.

## Verification

```sh
npm run validate
npm run test:qa
```

The opt-in QA integration test runs a localhost fixture in actual Chromium at
desktop and mobile sizes, checks PNG dimensions, exercises fill/click/assertions,
and proves error, HTTP failure, screenshot-on-failure, and cleanup behavior.
The ordinary suite includes schema, output bounds, isolation, Git drift,
failure/cleanup, and subprocess timeout tests without needing a browser engine.
