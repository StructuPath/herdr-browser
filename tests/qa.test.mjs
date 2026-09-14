import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { validateScenario, loadScenario, gitState, engineEnvironment, classifyTelemetry, boundResult, createEngine, runQa } from "../bin/qa.mjs";

function scenario(overrides = {}) {
	return { schemaVersion: 1, name: "Fixture", baseUrl: "http://127.0.0.1:3456", viewports: [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }], steps: [{ type: "navigate", path: "/" }, { type: "assertText", selector: "h1", contains: "Ready" }], ...overrides };
}
function fixture(t, settings = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-qa-unit-"));
	t.after(() => fs.rmSync(root, { force: true, recursive: true }));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	const config = path.join(repo, "qa.json");
	fs.writeFileSync(config, JSON.stringify(scenario(settings)));
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q"); git("config", "user.email", "fixture@example.test"); git("config", "user.name", "Fixture");
	git("add", "qa.json"); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
	const binary = path.join(root, "engine");
	fs.writeFileSync(binary, '#!/bin/sh\nprintf "agent-browser 0.33.2\\n"\n', { mode: 0o700 });
	return { root, repo, config, binary, git, output: path.join(root, "evidence") };
}
function fakeFactory(log, mutate) {
	return ({ session }) => async (args, options) => {
		log.push({ session, args, options });
		await mutate?.(args);
		if (args[0] === "screenshot") fs.writeFileSync(args[1], Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		if (args[0] === "get") return { text: "Ready", title: "Ready", url: "http://127.0.0.1:3456/" };
		if (args[0] === "is") return { visible: true };
		if (args[0] === "console") return { messages: [] };
		if (args[0] === "errors") return { errors: [] };
		if (args[0] === "network") return { requests: [] };
		return {};
	};
}

test("QA schema is declarative and bounds options, counts, URLs, filenames, and CLI operands", () => {
	assert.equal(validateScenario(scenario()).timeoutMs, 10_000);
	for (const invalid of [
		scenario({ eval: "anything" }), scenario({ steps: [{ type: "eval", code: "anything" }] }),
		scenario({ steps: [{ type: "navigate", path: "//foreign.test" }] }),
		scenario({ steps: [{ type: "navigate", path: "/\\foreign.test" }] }),
		scenario({ steps: [{ type: "navigate", path: "/" }, { type: "fill", selector: "#a", value: "--cdp" }] }),
		scenario({ steps: [{ type: "navigate", path: "/" }, { type: "screenshot", name: "../secret" }] }),
		scenario({ baseUrl: "file:///tmp/anything" }), scenario({ baseUrl: "https://user:pass@example.test" }),
		scenario({ timeoutMs: 100_000 }), scenario({ failOnConsoleError: "false" }),
		scenario({ viewports: [{ name: "huge", width: 10_000, height: 800 }] }),
		scenario({ viewports: [scenario().viewports[0], scenario().viewports[0]] }),
	]) assert.throws(() => validateScenario(invalid));
});

test("QA config is byte-bounded and resolved overrides affect its evidence digest", (t) => {
	const f = fixture(t);
	const first = loadScenario(f.config);
	assert.notEqual(loadScenario(f.config, "http://localhost:1234").sha256, first.sha256);
	fs.writeFileSync(f.config, " ".repeat(65 * 1024));
	assert.throws(() => loadScenario(f.config), /64 KiB/);
});

test("QA config rejects symlinks and FIFOs without blocking", (t) => {
	const f = fixture(t);
	const link = path.join(f.root, "link.json");
	fs.symlinkSync(f.config, link);
	assert.throws(() => loadScenario(link), /ELOOP/);
	const fifo = path.join(f.root, "pipe");
	execFileSync("mkfifo", [fifo]);
	assert.throws(() => loadScenario(fifo), /regular file/);
	assert.throws(() => loadScenario(f.repo), /regular file/);
});

test("QA Git metadata ignores inherited repository/config overrides and never runs fsmonitor", async (t) => {
	const f = fixture(t); const other = fixture(t);
	const marker = path.join(f.root, "fsmonitor-ran");
	const monitor = path.join(f.root, "monitor");
	fs.writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
	f.git("config", "core.fsmonitor", monitor);
	fs.writeFileSync(path.join(other.repo, "different.txt"), "different");
	other.git("add", "different.txt"); other.git("-c", "commit.gpgsign=false", "commit", "-qm", "different");
	const state = await gitState(f.repo, { ...process.env, GIT_DIR: path.join(other.repo, ".git"), GIT_WORK_TREE: other.repo,
		GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: other.repo });
	assert.equal(state.commit, f.git("rev-parse", "HEAD"));
	assert.equal(state.root, fs.realpathSync(f.repo));
	assert.equal(state.dirty, false);
	assert.equal(fs.existsSync(marker), false);
});

test("QA engine does not inherit shared sessions, remote providers, profiles, init scripts, or credentials", () => {
	const env = engineEnvironment({ PATH: "/bin", HOME: "/home/fixture", AGENT_BROWSER_EXECUTABLE_PATH: "/chrome", AGENT_BROWSER_SESSION: "shared", AGENT_BROWSER_PROVIDER: "paid", AGENT_BROWSER_RESTORE: "auth", AGENT_BROWSER_INIT_SCRIPTS: "/script", API_KEY: "secret", NODE_OPTIONS: "--require=bad" }, 1000);
	assert.deepEqual(Object.keys(env).sort(), ["AGENT_BROWSER_DEFAULT_TIMEOUT", "AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_IDLE_TIMEOUT_MS", "HOME", "PATH"].sort());
});

test("QA telemetry distinguishes failed HTTP responses from incomplete requests and strips URL secrets", () => {
	const observed = classifyTelemetry({ messages: [{ type: "error", text: "broken" }, { type: "log", text: "fine" }] }, { errors: ["page threw"] }, { requests: [
		{ status: 500, url: "https://user:pass@example.test/api?token=private#secret", method: "POST" },
		{ status: 200 }, { status: null },
	] });
	assert.equal(observed.consoleErrors.length, 1);
	assert.equal(observed.pageErrors.length, 1);
	assert.equal(observed.failedRequests[0].url, "https://example.test/api");
	assert.equal(observed.unresolvedRequests, 1);
	assert.throws(() => classifyTelemetry({}, [], []), /invalid messages/);
	assert.throws(() => classifyTelemetry(Array(101).fill({}), [], []), /incomplete/);
});

test("QA bounds final JSON and marks oversized raw telemetry as incomplete evidence", () => {
	const result = { status: "passed", summary: { viewports: 4, passed: 4, failed: 0, consoleErrors: 400 }, runs: Array.from({ length: 4 }, () => ({ status: "passed", consoleErrors: Array.from({ length: 100 }, () => ({ message: "\0".repeat(2000) })), pageErrors: [], failedRequests: [] })) };
	boundResult(result);
	assert.equal(result.status, "failed");
	assert.equal(result.summary.failed, 4);
	assert.equal(result.summary.consoleErrors, 400);
	assert.match(result.error, /incomplete/);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
});

test("QA passes both isolated viewports, writes private commit-bound evidence, and closes only owned sessions", async (t) => {
	const f = fixture(t); const log = [];
	const result = await runQa({ ...f, engineFactory: fakeFactory(log) });
	assert.equal(result.status, "passed");
	assert.equal(result.git.commit, f.git("rev-parse", "HEAD"));
	assert.equal(result.git.dirty, false);
	assert.equal(result.git.changedDuringRun, false);
	assert.equal(result.summary.assertions, 2);
	assert.deepEqual(result.scenario.policy, { failOnConsoleError: true, failOnPageError: true, failOnFailedRequest: true });
	assert.equal(new Set(log.map(({ session }) => session)).size, 2);
	assert.ok(log.every(({ session }) => session.length < 50));
	assert.equal(log.filter(({ args }) => args[0] === "close").length, 2);
	assert.ok(log.every(({ args }) => !args.includes("--all") && !args.includes("eval")));
	assert.equal(fs.statSync(result.resultPath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(f.output).mode & 0o777, 0o700);
	assert.equal(JSON.parse(fs.readFileSync(result.resultPath)).runs[1].artifacts[0].path, "mobile-final.png");
});

test("QA records explicitly relaxed telemetry policy alongside passing criteria", async (t) => {
	const f = fixture(t, { failOnConsoleError: false });
	const factory = fakeFactory([]);
	const result = await runQa({ ...f, engineFactory: (options) => {
		const engine = factory(options);
		return async (args, opts) => args[0] === "console" ? { messages: [{ type: "error", text: "intentional fixture error" }] } : engine(args, opts);
	} });
	assert.equal(result.status, "passed");
	assert.equal(result.summary.consoleErrors, 2);
	assert.equal(result.scenario.policy.failOnConsoleError, false);
	assert.equal(result.scenario.policy.failOnPageError, true);
});

test("QA assertions fail visibly, still collect final evidence and clean up", async (t) => {
	const f = fixture(t, { steps: [{ type: "navigate", path: "/" }, { type: "assertText", selector: "h1", contains: "missing" }] });
	const log = [];
	const result = await runQa({ ...f, engineFactory: fakeFactory(log) });
	assert.equal(result.status, "failed");
	assert.match(result.runs[0].steps[1].error, /assertion failed/);
	assert.equal(result.runs[0].artifacts.length, 1);
	assert.equal(log.filter(({ args }) => args[0] === "close").length, 2);
});

test("QA detects Git changes and cleanup failures without claiming success", async (t) => {
	const f = fixture(t);
	const result = await runQa({ ...f, engineFactory: fakeFactory([], (args) => {
		if (args[0] === "get") fs.writeFileSync(path.join(f.repo, "new.txt"), "changed");
		if (args[0] === "close") throw new Error("close failed");
	}) });
	assert.equal(result.git.changedDuringRun, true);
	assert.equal(result.status, "failed");
	assert.equal(result.cleanup.status, "failed");
});

test("QA refuses output reuse and repository-local output before browser commands", async (t) => {
	const f = fixture(t);
	const options = { ...f, engineFactory: () => { throw new Error("must not run"); } };
	await assert.rejects(runQa({ ...options, output: path.join(f.repo, "evidence") }), /outside/);
	assert.equal(fs.existsSync(path.join(f.repo, "evidence")), false);
	const link = path.join(f.root, "repo-link"); fs.symlinkSync(f.repo, link);
	await assert.rejects(runQa({ ...options, output: path.join(link, "evidence") }), /outside/);
	fs.mkdirSync(f.output);
	await assert.rejects(runQa(options), /EEXIST/);
});

test("QA engine times out a hanging command and never exposes filled text in subprocess errors", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.binary, '#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n');
	const engine = createEngine({ binary: f.binary, session: "owned", configFile: f.config, cwd: f.root, env: process.env, timeoutMs: 100, deadline: Date.now() + 100, signal: undefined });
	await assert.rejects(engine(["fill", "#input", "private-value"]), (error) => /timed out/.test(error.message) && !error.message.includes("private-value"));
});
