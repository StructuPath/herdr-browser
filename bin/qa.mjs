#!/usr/bin/env node
// Saved declarative QA against a fresh agent-browser session for each viewport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_CONFIG = 64 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RESULT = 1024 * 1024;
const MAX_ENTRIES = 100;
const TYPES = {
	navigate: ["path"], click: ["selector"], fill: ["selector", "value"],
	waitFor: ["selector"], assertText: ["selector", "contains"],
	assertVisible: ["selector"], assertUrl: ["contains"],
	assertTitle: ["contains"], screenshot: ["name"],
};

function object(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
function string(value, label, max = 1000) {
	if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error(`${label} must be nonempty text of at most ${max} characters without control characters`);
	}
}
function slug(value, label) {
	if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw new Error(`${label} must be a lowercase slug (max 40 characters)`);
}
function integer(value, min, max, label) {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
}
function baseUrl(value) {
	string(value, "baseUrl", 2000);
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
	}
	return url;
}

export function validateScenario(value) {
	object(value, ["schemaVersion", "name", "baseUrl", "viewports", "steps", "timeoutMs", "runTimeoutMs", "failOnConsoleError", "failOnPageError", "failOnFailedRequest"], "scenario");
	if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
	string(value.name, "name", 120);
	const base = baseUrl(value.baseUrl);
	if (!Array.isArray(value.viewports) || value.viewports.length < 1 || value.viewports.length > 4) throw new Error("viewports must contain 1–4 entries");
	const names = new Set();
	for (const viewport of value.viewports) {
		object(viewport, ["name", "width", "height"], "viewport");
		slug(viewport.name, "viewport name");
		if (names.has(viewport.name)) throw new Error("viewport names must be unique");
		names.add(viewport.name);
		integer(viewport.width, 320, 1920, "viewport width");
		integer(viewport.height, 240, 1600, "viewport height");
	}
	if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 40) throw new Error("steps must contain 1–40 entries");
	if (value.steps[0]?.type !== "navigate") throw new Error("first step must navigate");
	for (const step of value.steps) {
		const fields = TYPES[step?.type];
		if (!fields) throw new Error("unknown step type; scripts and eval are not supported");
		object(step, ["type", ...fields], "step");
		for (const field of fields) string(step[field], `step ${field}`);
		for (const field of ["selector", "value"]) {
			if (step[field]?.startsWith("-")) throw new Error(`step ${field} must not begin with '-'`);
		}
		if (step.type === "screenshot") slug(step.name, "screenshot name");
		if (step.type === "navigate") {
			if (!step.path.startsWith("/") || step.path.startsWith("//") || step.path.includes("\\")) throw new Error("navigate path must be an origin-relative /path");
			if (new URL(step.path, base).origin !== base.origin) throw new Error("navigate must stay on baseUrl origin");
		}
	}
	for (const key of ["failOnConsoleError", "failOnPageError", "failOnFailedRequest"]) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${key} must be boolean`);
	}
	integer(value.timeoutMs ?? 10_000, 100, 30_000, "timeoutMs");
	integer(value.runTimeoutMs ?? 120_000, 1000, 300_000, "runTimeoutMs");
	return {
		...value, timeoutMs: value.timeoutMs ?? 10_000, runTimeoutMs: value.runTimeoutMs ?? 120_000,
		failOnConsoleError: value.failOnConsoleError ?? true,
		failOnPageError: value.failOnPageError ?? true,
		failOnFailedRequest: value.failOnFailedRequest ?? true,
	};
}

export function loadScenario(file, override) {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	let bytes;
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new Error("scenario must be a regular file, not a pipe or device");
		if (stat.size > MAX_CONFIG) throw new Error("scenario exceeds 64 KiB");
		const buffer = Buffer.alloc(MAX_CONFIG + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (!read) break;
			length += read;
		}
		if (length > MAX_CONFIG) throw new Error("scenario exceeds 64 KiB");
		bytes = buffer.subarray(0, length);
	} finally { fs.closeSync(fd); }
	const parsed = JSON.parse(bytes);
	if (override !== undefined) parsed.baseUrl = override;
	const scenario = validateScenario(parsed);
	return { scenario, sha256: hash(JSON.stringify(scenario)) };
}

export async function gitState(repo, env = process.env) {
	const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
	Object.assign(gitEnv, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" });
	const git = async (...args) => (await execute("git", ["--no-pager", "-c", "core.fsmonitor=false", "-C", repo, ...args], { env: gitEnv, timeout: 5000, maxBuffer: MAX_OUTPUT })).stdout;
	const commit = (await git("rev-parse", "HEAD")).trim();
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("QA requires a Git repository with a committed SHA-1 HEAD");
	const root = fs.realpathSync((await git("rev-parse", "--show-toplevel")).trim());
	const status = await git("status", "--porcelain=v1", "--untracked-files=all");
	const diff = await git("diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv");
	const branch = (await git("branch", "--show-current")).trim() || null;
	return { root, commit, branch, dirty: status.length !== 0, fingerprint: hash(status + diff) };
}

// Engine defaults/extensions/profiles/remote providers from the user's environment
// must not turn a fresh QA session into an attached or authenticated session.
export function engineEnvironment(env, timeoutMs) {
	const result = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY", "AGENT_BROWSER_EXECUTABLE_PATH"]) {
		if (env[key] !== undefined) result[key] = env[key];
	}
	result.AGENT_BROWSER_DEFAULT_TIMEOUT = String(timeoutMs);
	result.AGENT_BROWSER_IDLE_TIMEOUT_MS = "60000";
	return result;
}

function text(value) { return String(value ?? "").slice(0, 2000); }
function safeUrl(value) {
	try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return text(url.href); }
	catch { return "[unavailable URL]"; }
}
function entries(data, key) {
	const items = Array.isArray(data) ? data : data?.[key];
	if (!Array.isArray(items)) throw new Error(`engine returned invalid ${key} telemetry`);
	if (items.length > MAX_ENTRIES) throw new Error(`${key} telemetry exceeds ${MAX_ENTRIES} entries; evidence would be incomplete`);
	return items;
}

export function classifyTelemetry(consoleData, errorData, requestData) {
	const messages = entries(consoleData, "messages");
	const errors = entries(errorData, "errors");
	const requests = entries(requestData, "requests");
	return {
		consoleErrors: messages.filter((item) => item.type === "error" || item.level === "error").map((item) => ({ message: text(item.text ?? item.message) })),
		pageErrors: errors.map((item) => ({ message: text(typeof item === "string" ? item : item.message ?? item.text) })),
		failedRequests: requests.filter((item) => Number(item.status) >= 400 || item.failure || item.error).map((item) => ({
			method: text(item.method ?? "GET"), url: safeUrl(item.url), status: typeof item.status === "number" ? item.status : null,
		})),
		unresolvedRequests: requests.filter((item) => item.status == null && !item.failure && !item.error).length,
	};
}

export function createEngine({ binary, session, configFile, cwd, env, timeoutMs, deadline, signal }) {
	return async (args, { cleanup = false } = {}) => {
		const remaining = cleanup ? 10_000 : Math.min(timeoutMs + 1000, deadline - Date.now());
		if (remaining <= 0) throw new Error("QA run deadline exceeded");
		try {
			const { stdout } = await execute(binary, ["--config", configFile, "--session", session, "--json", ...args], {
				cwd, env, timeout: remaining, maxBuffer: MAX_OUTPUT, signal: cleanup ? undefined : signal,
				killSignal: "SIGKILL",
			});
			const result = JSON.parse(stdout);
			if (result.success !== true) throw new Error(text(result.error || "engine command failed"));
			return result.data;
		} catch (error) {
			if (error.killed || error.name === "AbortError") throw new Error("engine command timed out or was interrupted");
			// execFile errors embed arguments/stdout; do not accidentally publish filled values.
			if (error.code) throw new Error(`engine command failed (${error.code})`);
			throw new Error(text(error.message));
		}
	};
}

function saveJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

export function boundResult(result) {
	if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 <= MAX_RESULT) return;
	result.status = "failed";
	result.error = "Evidence exceeds 1 MiB; raw telemetry omitted. This run is incomplete.";
	result.summary.passed = 0;
	result.summary.failed = result.summary.viewports;
	for (const run of result.runs) {
		run.status = "failed";
		run.consoleErrors = [];
		run.pageErrors = [];
		run.failedRequests = [];
	}
}

export async function runQa({ config, repo, output, baseUrl: override, binary = "agent-browser", env = process.env, signal, engineFactory = createEngine }) {
	const loaded = loadScenario(config, override);
	const scenario = loaded.scenario;
	const before = await gitState(repo, env);
	const outputDir = output ? path.join(fs.realpathSync(path.dirname(path.resolve(output))), path.basename(path.resolve(output))) : fs.mkdtempSync(path.join(os.tmpdir(), "herdr-qa-"));
	if (outputDir === before.root || outputDir.startsWith(`${before.root}${path.sep}`)) throw new Error("QA output must be outside the tested repository");
	if (output) fs.mkdirSync(outputDir, { mode: 0o700 });
	fs.chmodSync(outputDir, 0o700);
	const configFile = path.join(outputDir, "engine-config.json");
	saveJson(configFile, {});
	const engineEnv = engineEnvironment(env, scenario.timeoutMs);
	const runId = randomUUID();
	const deadline = Date.now() + scenario.runTimeoutMs;
	const result = {
		schemaVersion: 1, kind: "herdr-browser-qa", runId, status: "failed",
		startedAt: new Date().toISOString(), finishedAt: null,
		scenario: { name: scenario.name, sha256: loaded.sha256, policy: {
			failOnConsoleError: scenario.failOnConsoleError,
			failOnPageError: scenario.failOnPageError,
			failOnFailedRequest: scenario.failOnFailedRequest,
		} },
		git: { commit: before.commit, branch: before.branch, dirty: before.dirty, changedDuringRun: false },
		engine: { name: "agent-browser", version: null },
		runs: [], cleanup: { status: "passed" },
	};
	const resultPath = path.join(outputDir, "result.json");
	try {
		const version = await execute(binary, ["--version"], { cwd: outputDir, env: engineEnv, timeout: 5000, maxBuffer: 4096 });
		result.engine.version = version.stdout.trim();
		const versionParts = /^agent-browser (\d+)\.(\d+)\.(\d+)$/.exec(result.engine.version);
		if (!versionParts || !(Number(versionParts[1]) > 0 || Number(versionParts[2]) >= 33)) throw new Error("QA requires agent-browser >=0.33.0");
		for (const viewport of scenario.viewports) {
			const run = { viewport, status: "failed", steps: [], artifacts: [], consoleErrors: [], pageErrors: [], failedRequests: [], unresolvedRequests: 0 };
			result.runs.push(run);
			const session = `herdr-qa-${runId.replaceAll("-", "")}-${result.runs.length}`;
			const engine = engineFactory({ binary, session, configFile, cwd: outputDir, env: engineEnv, timeoutMs: scenario.timeoutMs, deadline, signal });
			const screenshot = async (name) => {
				const relative = `${viewport.name}-${name}.png`;
				const target = path.join(outputDir, relative);
				await engine(["screenshot", target]);
				const stat = fs.lstatSync(target);
				if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("screenshot missing or exceeds 10 MiB");
				fs.chmodSync(target, 0o600);
				const bytes = fs.readFileSync(target);
				if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("engine screenshot is not PNG");
				run.artifacts.push({ kind: "screenshot", path: relative, sha256: hash(bytes), bytes: bytes.length });
			};
			let launched = false;
			try {
				launched = true;
				await engine(["open", "about:blank"]);
				await engine(["set", "viewport", String(viewport.width), String(viewport.height)]);
				await engine(["console", "--clear"]);
				await engine(["errors", "--clear"]);
				await engine(["network", "requests", "--clear"]);
				for (const [index, step] of scenario.steps.entries()) {
					const outcome = { index, type: step.type, status: "failed" };
					run.steps.push(outcome);
					try {
						if (step.type === "navigate") await engine(["open", new URL(step.path, scenario.baseUrl).href]);
						else if (step.type === "click") await engine(["click", step.selector]);
						else if (step.type === "fill") await engine(["fill", step.selector, step.value]);
						else if (step.type === "waitFor") await engine(["wait", step.selector]);
						else if (step.type === "screenshot") await screenshot(`${index}-${step.name}`);
						else {
							const args = step.type === "assertVisible" ? ["is", "visible", step.selector]
								: step.type === "assertText" ? ["get", "text", step.selector]
									: ["get", step.type === "assertUrl" ? "url" : "title"];
							const data = await engine(args);
							const key = { assertVisible: "visible", assertText: "text", assertUrl: "url", assertTitle: "title" }[step.type];
							const actual = data?.[key];
							if (step.type === "assertVisible" ? actual !== true : typeof actual !== "string" || !actual.includes(step.contains)) throw new Error(`${step.type} assertion failed`);
						}
						outcome.status = "passed";
					} catch (error) { outcome.error = text(error.message); throw error; }
				}
				run.status = "passed";
			} catch (error) { run.error = text(error.message); }
			finally {
				if (launched) {
					try { await screenshot("final"); } catch (error) { run.status = "failed"; run.evidenceError = text(error.message); }
					try {
						Object.assign(run, classifyTelemetry(await engine(["console"]), await engine(["errors"]), await engine(["network", "requests"])));
						if ((scenario.failOnConsoleError && run.consoleErrors.length) || (scenario.failOnPageError && run.pageErrors.length) || (scenario.failOnFailedRequest && (run.failedRequests.length || run.unresolvedRequests))) run.status = "failed";
					} catch (error) { run.status = "failed"; run.telemetryError = text(error.message); }
					try { await engine(["close"], { cleanup: true }); }
					catch (error) { result.cleanup.status = "failed"; run.cleanupError = text(error.message); run.status = "failed"; }
				}
			}
			if (signal?.aborted || Date.now() >= deadline) break;
		}
	} catch (error) { result.error = text(error.code ? `QA preflight failed (${error.code})` : error.message); }
	try {
		const after = await gitState(repo, env);
		result.git.changedDuringRun = before.commit !== after.commit || before.branch !== after.branch || before.fingerprint !== after.fingerprint;
	} catch { result.git.changedDuringRun = true; }
	result.summary = {
		viewports: scenario.viewports.length,
		passed: result.runs.filter((run) => run.status === "passed").length,
		failed: scenario.viewports.length - result.runs.filter((run) => run.status === "passed").length,
		assertions: result.runs.reduce((sum, run) => sum + run.steps.filter((step) => step.type.startsWith("assert")).length, 0),
		consoleErrors: result.runs.reduce((sum, run) => sum + run.consoleErrors.length, 0),
		pageErrors: result.runs.reduce((sum, run) => sum + run.pageErrors.length, 0),
		failedRequests: result.runs.reduce((sum, run) => sum + run.failedRequests.length, 0),
	};
	result.status = result.summary.failed === 0 && !result.git.changedDuringRun && result.cleanup.status === "passed" && !result.error ? "passed" : "failed";
	if (signal?.aborted) { result.status = "failed"; result.error = "QA run interrupted"; }
	result.finishedAt = new Date().toISOString();
	boundResult(result);
	saveJson(resultPath, result);
	return { ...result, resultPath };
}

export async function main(argv = process.argv.slice(2)) {
	if (argv.includes("--help")) {
		console.log("Usage: qa.mjs check --config scenario.json\n       qa.mjs run --config scenario.json --repo /git/repo [--output /new/private/dir] [--base-url http://localhost:3000] [--json]\nQA uses fresh browser sessions; screenshots and messages may contain private data. Review evidence before sharing.");
		return 0;
	}
	const action = argv.shift();
	if (!["run", "check"].includes(action)) throw new Error("expected run or check; use --help");
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (key === "--json") { options.json = true; continue; }
		if (!["--config", "--repo", "--output", "--base-url"].includes(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`invalid option ${key}`);
		if (options[key] !== undefined) throw new Error(`duplicate option ${key}`);
		options[key] = argv[++i];
	}
	if (!options["--config"]) throw new Error("--config is required");
	if (action === "check") {
		const { scenario, sha256 } = loadScenario(options["--config"], options["--base-url"]);
		console.log(JSON.stringify({ schemaVersion: 1, status: "valid", name: scenario.name, sha256 }));
		return 0;
	}
	if (!options["--repo"]) throw new Error("--repo is required");
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		const result = await runQa({ config: options["--config"], repo: options["--repo"], output: options["--output"], baseUrl: options["--base-url"], signal: controller.signal });
		console.log(options.json ? JSON.stringify(result) : `${result.status.toUpperCase()}: ${result.summary.passed}/${result.summary.viewports} viewports; evidence ${result.resultPath}`);
		return result.status === "passed" ? 0 : 1;
	} finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().then((code) => { process.exitCode = code; }, (error) => { console.error(`QA: ${text(error.message)}`); process.exitCode = 2; });
}
