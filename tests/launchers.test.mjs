import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

let stubDir, stateDir, logFile;

function writeStub(name, body) {
	const p = path.join(stubDir, name);
	fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}`);
	fs.chmodSync(p, 0o755);
}

function freshEnv(overrides = {}) {
	fs.writeFileSync(logFile, "");
	return {
		PATH: `${stubDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: os.homedir(),
		STUB_LOG: logFile,
		HERDR_BIN_PATH: path.join(stubDir, "herdr"),
		HERDR_PLUGIN_ROOT: repoRoot,
		HERDR_PLUGIN_STATE_DIR: stateDir,
		HERDR_WORKSPACE_ID: "w9",
		...overrides,
	};
}

function runScript(script, args = [], env = freshEnv()) {
	return spawnSync("bash", [path.join(repoRoot, "scripts", script), ...args], {
		env,
		encoding: "utf8",
	});
}

const log = () => fs.readFileSync(logFile, "utf8");

before(() => {
	stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-stub-"));
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-state-"));
	logFile = path.join(stubDir, "calls.log");
	writeStub(
		"agent-browser",
		`echo "agent-browser $@" >> "$STUB_LOG"
echo '{"success":true,"data":{}}'`,
	);
	writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "pane" ] && [ "$2" = "read" ]; then exit "\${STUB_PANE_ALIVE:-1}"; fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  # Mirrors the real herdr 0.7.4 pane_list schema: plugin panes carry the
  # manifest pane title as "label"; plain terminal panes have no label.
  echo '{"id":"cli:pane:list","result":{"panes":[{"agent_status":"unknown","label":"Browser","pane_id":"w9:p9","tab_id":"w9:t1","workspace_id":"w9"},{"agent":"claude","agent_status":"idle","pane_id":"w9:p4","tab_id":"w9:t1","terminal_title":"claude","workspace_id":"w9"}],"type":"pane_list"}}'
fi
if [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  [ -n "\${STUB_OPEN_SLEEP:-}" ] && sleep "$STUB_OPEN_SLEEP"
  if [ -n "\${STUB_PRETTY:-}" ]; then
    printf '{\\n  "result": {\\n    "plugin_pane": {"pane": {"pane_id": "w9:p7"}}\\n  }\\n}\\n'
  else
    echo '{"id":"x","result":{"plugin_pane":{"pane":{"pane_id":"w9:p7"}}}}'
  fi
fi
exit 0`,
	);
});

test("open with URL navigates workspace session and opens pane", () => {
	const r = runScript("open.sh", ["http://localhost:3000"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		log(),
		/agent-browser --session herdr-ws-w9 open http:\/\/localhost:3000/,
	);
	assert.match(log(), /herdr plugin pane open --plugin structupath\.browser/);
	assert.equal(
		fs.readFileSync(path.join(stateDir, "pane-id-w9"), "utf8").trim(),
		"w9:p7",
	);
});

test("open with live pane focuses instead of opening a second pane", () => {
	fs.writeFileSync(path.join(stateDir, "pane-id-w9"), "w9:p7\n");
	const r = runScript(
		"open.sh",
		["http://localhost:4000"],
		freshEnv({ STUB_PANE_ALIVE: "0" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /herdr plugin pane focus w9:p7/);
	assert.doesNotMatch(log(), /plugin pane open/);
});

test("URL-less open is view-only: ensures pane, never navigates", () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	const r = runScript("open.sh");
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(log(), /agent-browser --session \S+ open/);
	assert.match(log(), /herdr plugin pane open/);
});

test("flag-like URL is refused before any tool runs", () => {
	const r = runScript("open.sh", ["-rf"]);
	assert.equal(r.status, 2);
	assert.doesNotMatch(log(), /agent-browser/);
	assert.doesNotMatch(log(), /pane open/);
});

test("non-http scheme is refused", () => {
	const r = runScript("open.sh", ["file:///etc/passwd"]);
	assert.equal(r.status, 2);
	assert.doesNotMatch(log(), /agent-browser/);
});

test("missing agent-browser fails fast with install hint, no pane", () => {
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), "hb-bare-"));
	for (const t of ["herdr"]) {
		fs.copyFileSync(path.join(stubDir, t), path.join(bare, t));
		fs.chmodSync(path.join(bare, t), 0o755);
	}
	const r = runScript(
		"open.sh",
		["http://localhost:3000"],
		freshEnv({ PATH: `${bare}:/usr/bin:/bin` }),
	);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /npm install -g agent-browser/);
	assert.doesNotMatch(log(), /pane open/);
});

test("pretty-printed pane-open output still records the pane id", () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	const r = runScript(
		"open.sh",
		["http://localhost:3000"],
		freshEnv({ STUB_PRETTY: "1" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		fs.readFileSync(path.join(stateDir, "pane-id-w9"), "utf8").trim(),
		"w9:p7",
	);
});

test("concurrent opens are serialized: one pane opens, the other focuses it", async () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	fs.rmSync(path.join(stateDir, "open-lock-w9"), {
		recursive: true,
		force: true,
	});
	// Slow pane-open keeps invoke A inside the critical section while B waits;
	// pane read reports alive so B takes the focus path once A has tracked it.
	const env = freshEnv({ STUB_OPEN_SLEEP: "0.5", STUB_PANE_ALIVE: "0" });
	const runAsync = () =>
		new Promise((resolve) => {
			const c = spawn("bash", [path.join(repoRoot, "scripts", "open.sh")], {
				env,
			});
			c.on("close", (code) => resolve(code));
		});
	const [a, b] = await Promise.all([runAsync(), runAsync()]);
	assert.equal(a, 0);
	assert.equal(b, 0);
	const l = log();
	assert.equal(
		l.match(/plugin pane open/g).length,
		1,
		"exactly one pane opened",
	);
	assert.match(l, /plugin pane focus w9:p7/);
	assert.equal(
		fs.existsSync(path.join(stateDir, "open-lock-w9")),
		false,
		"lock released",
	);
});

test("a stale lock from a crashed opener is stolen, not waited on forever", () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	fs.mkdirSync(path.join(stateDir, "open-lock-w9"), { recursive: true });
	const r = runScript(
		"open.sh",
		[],
		freshEnv({ HERDR_BROWSER_LOCK_TRIES: "3" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /plugin pane open/);
	assert.equal(
		fs.existsSync(path.join(stateDir, "open-lock-w9")),
		false,
		"lock released",
	);
});

test("close removes only this workspace screenshot cache", () => {
	fs.writeFileSync(path.join(stateDir, "shot-w9.png"), "x");
	fs.writeFileSync(path.join(stateDir, "shot-w9.png.tmp"), "x");
	fs.writeFileSync(path.join(stateDir, "shot-w9.jpg"), "x");
	fs.writeFileSync(path.join(stateDir, "shot-w9.jpg.123.tmp"), "x");
	fs.writeFileSync(path.join(stateDir, "shot-other.png"), "x");
	fs.writeFileSync(path.join(stateDir, "shot-other.jpg"), "x");
	const r = runScript("close.sh");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(fs.existsSync(path.join(stateDir, "shot-w9.png")), false);
	assert.equal(fs.existsSync(path.join(stateDir, "shot-w9.png.tmp")), false);
	assert.equal(fs.existsSync(path.join(stateDir, "shot-w9.jpg")), false);
	assert.equal(
		fs.existsSync(path.join(stateDir, "shot-w9.jpg.123.tmp")),
		false,
	);
	assert.equal(fs.existsSync(path.join(stateDir, "shot-other.png")), true);
	assert.equal(fs.existsSync(path.join(stateDir, "shot-other.jpg")), true);
});

test("browse with URL opens browse pane passing URL via env", () => {
	fs.rmSync(path.join(stateDir, "browse-ids-w9"), { force: true });
	const r = runScript("browse.sh", ["http://localhost:3000"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /--entrypoint browse/);
	assert.match(log(), /HERDR_BROWSE_URL=http:\/\/localhost:3000/);
});

test("browse records its pane id so close can find it", () => {
	fs.rmSync(path.join(stateDir, "browse-ids-w9"), { force: true });
	runScript("browse.sh", ["http://localhost:3000"]);
	runScript("browse.sh", ["http://localhost:4000"]);
	assert.deepEqual(
		fs
			.readFileSync(path.join(stateDir, "browse-ids-w9"), "utf8")
			.trim()
			.split("\n"),
		["w9:p7", "w9:p7"],
	);
});

test("close closes recorded browse panes and removes the record", () => {
	fs.writeFileSync(path.join(stateDir, "browse-ids-w9"), "w9:p5\nw9:p6\n");
	const r = runScript("close.sh");
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /herdr pane close w9:p5/);
	assert.match(log(), /herdr pane close w9:p6/);
	assert.equal(fs.existsSync(path.join(stateDir, "browse-ids-w9")), false);
});

test("close closes the tracked pane even when liveness cannot be confirmed", () => {
	fs.writeFileSync(path.join(stateDir, "pane-id-w9"), "w9:p7\n");
	const r = runScript("close.sh", [], freshEnv({ STUB_PANE_ALIVE: "1" }));
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /herdr pane close w9:p7/);
	assert.equal(fs.existsSync(path.join(stateDir, "pane-id-w9")), false);
});

test("close reports what it did instead of exiting silently", () => {
	fs.writeFileSync(path.join(stateDir, "pane-id-w9"), "w9:p7\n");
	const r = runScript("close.sh");
	assert.match(r.stdout, /closed \d+ pane\(s\); session herdr-ws-w9 released/);
});

test("browse refuses flag-like and non-http URLs", () => {
	assert.equal(runScript("browse.sh", ["-evil"]).status, 2);
	assert.equal(runScript("browse.sh", ["file:///etc/passwd"]).status, 2);
});

test("browse with no URL opens pane without URL env (pane will prompt)", () => {
	const r = runScript("browse.sh");
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /--entrypoint browse/);
	assert.doesNotMatch(log(), /HERDR_BROWSE_URL/);
});

test("close sweeps untracked Browser panes in its workspace only", () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	fs.rmSync(path.join(stateDir, "browse-ids-w9"), { force: true });
	const r = runScript("close.sh");
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		log(),
		/herdr pane list --workspace w9/,
		"sweep scoped to workspace",
	);
	assert.match(log(), /herdr pane close w9:p9/);
	assert.doesNotMatch(log(), /pane close w9:p4/, "non-plugin panes untouched");
});

test("close closes pane then session, never --all", () => {
	fs.writeFileSync(path.join(stateDir, "pane-id-w9"), "w9:p7\n");
	const r = runScript("close.sh", [], freshEnv({ STUB_PANE_ALIVE: "0" }));
	assert.equal(r.status, 0, r.stderr);
	const l = log();
	assert.match(l, /herdr pane close w9:p7/);
	assert.match(l, /agent-browser --session herdr-ws-w9 close/);
	assert.doesNotMatch(l, /--all/);
	assert.ok(
		l.indexOf("pane close") < l.indexOf("--session herdr-ws-w9 close"),
		"pane must close before session",
	);
	assert.equal(fs.existsSync(path.join(stateDir, "pane-id-w9")), false);
});

// --- Wave 1 additions ---

// browse-pane needs its own stub dir: its error paths `sleep 600` to keep the
// pane readable, so a sleep stub is required — but a shared sleep stub would
// break open.sh's lock timing. Per-test dir keeps it isolated.
function mkBrowsePaneEnv(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-bp-"));
	const log = path.join(dir, "bp.log");
	fs.writeFileSync(log, "");
	for (const [name, body] of [
		["carbonyl", `echo "carbonyl $@" >> "${log}"\nexit 0`],
		["sleep", "exit 0"],
	]) {
		fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}`);
		fs.chmodSync(path.join(dir, name), 0o755);
	}
	return {
		env: {
			PATH: `${dir}:/usr/bin:/bin`,
			HOME: os.homedir(),
			HERDR_PLUGIN_ROOT: repoRoot,
			HERDR_PLUGIN_STATE_DIR: stateDir,
			HERDR_WORKSPACE_ID: "w9",
			...overrides,
		},
		log: () => fs.readFileSync(log, "utf8"),
	};
}

const runBrowsePane = (env, input) =>
	spawnSync("bash", [path.join(repoRoot, "scripts", "browse-pane.sh")], {
		env,
		encoding: "utf8",
		input,
	});

test("open navigates via HERDR_PLUGIN_CLICKED_URL and refuses a bad one", () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	const ok = runScript(
		"open.sh",
		[],
		freshEnv({ HERDR_PLUGIN_CLICKED_URL: "http://localhost:5000" }),
	);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(
		log(),
		/agent-browser --session herdr-ws-w9 open http:\/\/localhost:5000/,
	);
	const bad = runScript(
		"open.sh",
		[],
		freshEnv({ HERDR_PLUGIN_CLICKED_URL: "file:///etc/passwd" }),
	);
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /refusing URL/);
});

test("URL policy: userinfo refused, uppercase scheme accepted, path @ kept", () => {
	assert.equal(runScript("open.sh", ["http://user@localhost:3000"]).status, 2);
	assert.equal(
		runScript("open.sh", ["https://user:pass@localhost/"]).status,
		2,
	);
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	const caps = runScript("open.sh", ["HTTP://LOCALHOST:3000"]);
	assert.equal(caps.status, 0, caps.stderr);
	assert.match(log(), /open HTTP:\/\/LOCALHOST:3000/);
	const at = runScript("open.sh", ["http://localhost:3000/@path"]);
	assert.equal(at.status, 0, at.stderr);
});

test("two waiters on a stale lock: exactly one pane opens (race regression)", async () => {
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	fs.rmSync(path.join(stateDir, "open-lock-w9"), {
		recursive: true,
		force: true,
	});
	// Crashed holder: lock dir with a dead holder's pid token inside.
	fs.mkdirSync(path.join(stateDir, "open-lock-w9"), { recursive: true });
	fs.writeFileSync(path.join(stateDir, "open-lock-w9", "pid"), "999999\n");
	const env = freshEnv({ HERDR_BROWSER_LOCK_TRIES: "3", STUB_PANE_ALIVE: "0" });
	const runAsync = () =>
		new Promise((resolve) => {
			const c = spawn("bash", [path.join(repoRoot, "scripts", "open.sh")], {
				env,
			});
			c.on("close", (code) => resolve(code));
		});
	const [a, b] = await Promise.all([runAsync(), runAsync()]);
	assert.equal(a, 0);
	assert.equal(b, 0);
	const l = log();
	assert.equal(l.match(/plugin pane open/g).length, 1, "mutual exclusion held");
	assert.match(l, /plugin pane focus w9:p7/);
	assert.equal(
		fs.existsSync(path.join(stateDir, "open-lock-w9")),
		false,
		"lock released",
	);
});

test(
	"garbage HERDR_BROWSER_LOCK_TRIES falls back to the default and still steals",
	() => {
		fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
		fs.mkdirSync(path.join(stateDir, "open-lock-w9"), { recursive: true });
		const r = runScript(
			"open.sh",
			[],
			freshEnv({ HERDR_BROWSER_LOCK_TRIES: "abc" }),
		);
		assert.equal(r.status, 0, r.stderr);
		assert.match(log(), /plugin pane open/);
	},
	{ timeout: 15000 },
);

test("open without herdr on PATH names the real problem", () => {
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), "hb-noherdr-"));
	fs.copyFileSync(
		path.join(stubDir, "agent-browser"),
		path.join(bare, "agent-browser"),
	);
	fs.chmodSync(path.join(bare, "agent-browser"), 0o755);
	const r = runScript(
		"open.sh",
		["http://localhost:3000"],
		freshEnv({ PATH: `${bare}:/usr/bin:/bin`, HERDR_BIN_PATH: "herdr" }),
	);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /herdr CLI not found/);
});

test("close warns when the stray-pane sweep is skipped (no node)", () => {
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), "hb-nonode-"));
	for (const t of ["herdr", "agent-browser"]) {
		fs.copyFileSync(path.join(stubDir, t), path.join(bare, t));
		fs.chmodSync(path.join(bare, t), 0o755);
	}
	fs.rmSync(path.join(stateDir, "pane-id-w9"), { force: true });
	fs.rmSync(path.join(stateDir, "browse-ids-w9"), { force: true });
	const r = runScript(
		"close.sh",
		[],
		freshEnv({ PATH: `${bare}:/usr/bin:/bin` }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /stray-pane sweep skipped/);
	assert.doesNotMatch(log(), /pane list/);
});

test("close reports the exact number of panes it closed", () => {
	fs.writeFileSync(path.join(stateDir, "pane-id-w9"), "w9:p7\n");
	fs.rmSync(path.join(stateDir, "browse-ids-w9"), { force: true });
	const r = runScript("close.sh");
	assert.match(r.stdout, /closed 2 pane\(s\)/, "tracked w9:p7 + swept w9:p9");
});

test("pane.sh exports the resolved session to the renderer", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pane-"));
	const logf = path.join(dir, "pane.log");
	fs.writeFileSync(logf, "");
	fs.writeFileSync(
		path.join(dir, "node"),
		`#!/usr/bin/env bash\necho "SESSION=$HERDR_BROWSER_SESSION" >> "${logf}"\nexit 0`,
	);
	fs.chmodSync(path.join(dir, "node"), 0o755);
	const r = spawnSync("bash", [path.join(repoRoot, "scripts", "pane.sh")], {
		env: {
			PATH: `${dir}:/usr/bin:/bin`,
			HOME: os.homedir(),
			HERDR_PLUGIN_ROOT: repoRoot,
			HERDR_WORKSPACE_ID: "w9",
		},
		encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(fs.readFileSync(logf, "utf8"), /SESSION=herdr-ws-w9/);
});

test("browse-pane validates the env URL instead of trusting it", () => {
	for (const bad of [
		"--user-data-dir=/tmp/x",
		"file:///etc/passwd",
		"chrome://flags",
	]) {
		const { env, log: l } = mkBrowsePaneEnv({ HERDR_BROWSE_URL: bad });
		const r = runBrowsePane(env);
		assert.equal(r.status, 1, bad);
		assert.match(r.stdout, /refusing URL/);
		assert.equal(l(), "", `carbonyl must not run for ${bad}`);
	}
	const { env, log: l } = mkBrowsePaneEnv({
		HERDR_BROWSE_URL: "http://localhost:3000",
	});
	const r = runBrowsePane(env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(l(), /carbonyl --zoom=100 http:\/\/localhost:3000/);
});

test("browse-pane prompt trims, prefixes bare hosts, and an empty answer exits", () => {
	const a = mkBrowsePaneEnv();
	const r1 = runBrowsePane(a.env, "  example.com  \n");
	assert.equal(r1.status, 0, r1.stderr);
	assert.match(a.log(), /carbonyl --zoom=100 https:\/\/example\.com/);
	const b = mkBrowsePaneEnv();
	const r2 = runBrowsePane(b.env, "HTTP://caps.example/x\n");
	assert.equal(r2.status, 0, r2.stderr);
	assert.match(b.log(), /carbonyl --zoom=100 HTTP:\/\/caps\.example\/x/);
	const c = mkBrowsePaneEnv();
	const r3 = runBrowsePane(c.env, "\n");
	assert.equal(r3.status, 0, r3.stderr);
	assert.equal(c.log(), "");
});

test("browse-pane clamps zoom to 25..500 with 100 as the garbage default", () => {
	const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "hb-zoom-"));
	const run = (zoomValue) => {
		fs.writeFileSync(path.join(cfg, "zoom"), zoomValue);
		const { env, log: l } = mkBrowsePaneEnv({
			HERDR_BROWSE_URL: "http://localhost:3000",
			HERDR_PLUGIN_CONFIG_DIR: cfg,
		});
		runBrowsePane(env);
		return l().trim();
	};
	assert.match(run("12a3\n"), /--zoom=123/);
	assert.match(run("abc\n"), /--zoom=100/);
	assert.match(run("999999\n"), /--zoom=500/);
	assert.match(run("5\n"), /--zoom=25/);
});

// --- Wave 2c: record action ---

test('record start/stop drive the workspace session and name the file', () => {
  const start = runScript('record.sh', ['start']);
  assert.equal(start.status, 0, start.stderr);
  assert.match(log(), /agent-browser --session herdr-ws-w9 record start .*\/recordings\/herdr-ws-w9-.*\.webm/);
  assert.match(start.stdout, /recording to .*\.webm/);
  const stop = runScript('record.sh', ['stop']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(log(), /agent-browser --session herdr-ws-w9 record stop/);
  assert.equal(runScript('record.sh', ['bogus']).status, 2);
});
