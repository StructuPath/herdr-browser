import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, MAX_RECORDING_BYTES, validateRunId } from "../bin/record.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t, overrides = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-browser-record-"));
	const state = path.join(base, "state");
	const bin = path.join(base, "bin");
	const config = path.join(base, "config");
	const calls = path.join(base, "calls");
	fs.mkdirSync(bin);
	fs.mkdirSync(config);
	fs.writeFileSync(path.join(bin, "agent-browser"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AB_CALLS"
if [ "$4" = "start" ]; then
  [ "${"$"}{AB_START_FAIL:-0}" = 1 ] && exit 9
  case "${"$"}{AB_ARTIFACT_MODE:-data}" in
    data) printf 'webm-test-data' > "$5" ;;
    empty) : > "$5" ;;
    missing) ;;
  esac
else
  [ "${"$"}{AB_STOP_FAIL:-0}" = 1 ] && exit 8
fi
exit 0
`, { mode: 0o755 });
	const env = {
		...process.env,
		PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
		HERDR_PLUGIN_ROOT: root,
		HERDR_PLUGIN_STATE_DIR: state,
		HERDR_PLUGIN_CONFIG_DIR: config,
		HERDR_WORKSPACE_ID: "workspace_1",
		HERDR_BROWSER_RUN_ID: "suite-run-1",
		HERDR_BROWSER_SESSION: "browser-session",
		AB_CALLS: calls,
		...overrides,
	};
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	return { base, state, config, calls, env };
}

function invoke(f, mode, overrides = {}) {
	return spawnSync("bash", [path.join(root, "scripts/record.sh"), mode], {
		env: { ...f.env, ...overrides }, encoding: "utf8",
	});
}

function bundle(f, runId = "suite-run-1") {
	const dir = path.join(f.state, "runs", `run-${runId}`, "browser");
	return {
		dir,
		manifest: path.join(dir, "evidence.json"),
		artifact: path.join(dir, "recording.webm"),
		pointer: path.join(f.state, "runs", "active-workspace_1.json"),
	};
}

function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

test("explicit run creates a private contained recording bundle and complete digest", (t) => {
	const f = fixture(t);
	const legacy = path.join(f.state, "recordings", "legacy.webm");
	fs.mkdirSync(path.dirname(legacy), { recursive: true });
	fs.writeFileSync(legacy, "legacy");
	const start = invoke(f, "start");
	assert.equal(start.status, 0, start.stderr);
	const b = bundle(f);
	const recording = json(b.manifest);
	assert.equal(recording.status, "recording");
	assert.equal(recording.review.status, "unreviewed");
	assert.equal(recording.review.attestation, "none");
	assert.equal(recording.artifact.path, "recording.webm");
	assert.ok(fs.existsSync(b.pointer));
	assert.match(fs.readFileSync(f.calls, "utf8"), /--session browser-session record start .*recording\.webm/);
	assert.equal(fs.statSync(b.dir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(b.manifest).mode & 0o777, 0o600);
	assert.equal(fs.statSync(b.pointer).mode & 0o777, 0o600);
	const stop = invoke(f, "stop");
	assert.equal(stop.status, 0, stop.stderr);
	const complete = json(b.manifest);
	assert.equal(complete.status, "complete");
	assert.equal(complete.artifact.bytes, 14);
	assert.equal(complete.artifact.sha256, crypto.createHash("sha256").update("webm-test-data").digest("hex"));
	assert.equal(complete.review.attestation, "none");
	assert.equal(fs.existsSync(b.pointer), false);
	assert.equal(fs.statSync(b.artifact).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(legacy, "utf8"), "legacy");
});

test("invalid, traversal, control, and oversized run IDs fail before the engine", (t) => {
	for (const id of ["../escape", "bad/name", "bad\nname", `a${"x".repeat(128)}`]) assert.throws(() => validateRunId(id));
	const f = fixture(t, { HERDR_BROWSER_RUN_ID: "../../escape" });
	const result = invoke(f, "start");
	assert.equal(result.status, 3);
	assert.equal(fs.existsSync(f.calls), false);
	assert.equal(fs.existsSync(path.join(f.base, "escape")), false);
});

test("config run ID is used when the environment is absent", (t) => {
	const f = fixture(t, { HERDR_BROWSER_RUN_ID: "" });
	fs.writeFileSync(path.join(f.config, "run-id"), "config-run.2\nignored\n");
	const result = invoke(f, "start");
	assert.equal(result.status, 0, result.stderr);
	assert.ok(fs.existsSync(bundle(f, "config-run.2").manifest));
});

test("generated run IDs are valid and distinct", (t) => {
	const first = fixture(t, { HERDR_BROWSER_RUN_ID: "", HERDR_WORKSPACE_ID: "a" });
	const second = fixture(t, { HERDR_BROWSER_RUN_ID: "", HERDR_WORKSPACE_ID: "b" });
	assert.equal(invoke(first, "start").status, 0);
	assert.equal(invoke(second, "start").status, 0);
	const id1 = fs.readdirSync(path.join(first.state, "runs")).find((name) => name.startsWith("run-")).slice(4);
	const id2 = fs.readdirSync(path.join(second.state, "runs")).find((name) => name.startsWith("run-")).slice(4);
	assert.equal(validateRunId(id1), id1);
	assert.notEqual(id1, id2);
});

test("session text never participates in paths and stop uses the pinned session", (t) => {
	const f = fixture(t, { HERDR_BROWSER_SESSION: "../../escape" });
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	assert.equal(json(b.manifest).browser_session, "../../escape");
	const stopped = invoke(f, "stop", { HERDR_BROWSER_SESSION: "changed-session", HERDR_BROWSER_RUN_ID: "changed-run" });
	assert.equal(stopped.status, 0, stopped.stderr);
	const calls = fs.readFileSync(f.calls, "utf8");
	assert.match(calls, /--session \.\.\/\.\.\/escape record stop/);
	assert.doesNotMatch(calls, /changed-session/);
	assert.equal(fs.existsSync(path.join(f.base, "escape")), false);
});

test("duplicate start refuses without overwriting the active state", (t) => {
	const f = fixture(t);
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	const before = fs.readFileSync(b.pointer, "utf8");
	const second = invoke(f, "start", { HERDR_BROWSER_RUN_ID: "suite-run-2" });
	assert.equal(second.status, 3);
	assert.match(second.stderr, /already active/);
	assert.equal(fs.readFileSync(b.pointer, "utf8"), before);
	assert.equal(fs.existsSync(bundle(f, "suite-run-2").dir), false);
});

test("start failure records failed state but creates no active pointer", (t) => {
	const f = fixture(t, { AB_START_FAIL: "1" });
	assert.equal(invoke(f, "start").status, 3);
	const b = bundle(f);
	assert.equal(json(b.manifest).status, "failed");
	assert.equal(fs.existsSync(b.pointer), false);
});

test("stop failure is retryable and never marks complete", (t) => {
	const f = fixture(t);
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	const failed = invoke(f, "stop", { AB_STOP_FAIL: "1" });
	assert.equal(failed.status, 3);
	assert.ok(fs.existsSync(b.pointer));
	assert.equal(json(b.manifest).status, "recording");
	assert.match(json(b.manifest).error, /exited 8/);
	assert.equal(invoke(f, "stop", { AB_STOP_FAIL: "0" }).status, 0);
	assert.equal(json(b.manifest).status, "complete");
});

test("missing, empty, special, and oversized artifacts cannot complete", async (t) => {
	for (const [name, mutate, mode = "data"] of [
		["missing", (b) => fs.rmSync(b.artifact), "data"],
		["empty", () => {}, "empty"],
		["directory", (b) => { fs.rmSync(b.artifact); fs.mkdirSync(b.artifact); }],
		["symlink", (b, f) => { fs.rmSync(b.artifact); fs.symlinkSync(path.join(f.base, "outside"), b.artifact); }],
		["oversized", (b) => fs.truncateSync(b.artifact, MAX_RECORDING_BYTES + 1)],
	]) {
		await t.test(name, (st) => {
			const f = fixture(st, { AB_ARTIFACT_MODE: mode });
			assert.equal(invoke(f, "start").status, 0);
			const b = bundle(f);
			mutate(b, f);
			const result = invoke(f, "stop");
			assert.equal(result.status, 3);
			assert.ok(fs.existsSync(b.pointer));
			assert.equal(json(b.manifest).status, "recording");
			if (name === "missing") {
				fs.writeFileSync(b.artifact, "webm-after-delay");
				const retry = invoke(f, "stop", { AB_STOP_FAIL: "1" });
				assert.equal(retry.status, 0, retry.stderr);
				assert.equal(json(b.manifest).status, "complete");
			}
		});
	}
});

test("symlink and oversized control files are refused", (t) => {
	const f = fixture(t);
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	fs.rmSync(b.pointer);
	fs.writeFileSync(path.join(f.base, "outside-pointer"), "{}");
	fs.symlinkSync(path.join(f.base, "outside-pointer"), b.pointer);
	assert.equal(invoke(f, "stop").status, 3);
	fs.rmSync(b.pointer);
	fs.writeFileSync(b.pointer, "x".repeat(65 * 1024));
	assert.equal(invoke(f, "stop").status, 3);
});

test("atomic JSON replacement remains valid and private", (t) => {
	const f = fixture(t);
	fs.mkdirSync(f.state, { mode: 0o700 });
	const canonical = fs.realpathSync(f.state);
	const target = path.join(canonical, "state.json");
	atomicWriteJson(canonical, target, { generation: 1 });
	atomicWriteJson(canonical, target, { generation: 2 });
	assert.deepEqual(json(target), { generation: 2 });
	assert.equal(fs.statSync(target).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(f.state), ["state.json"]);
});
