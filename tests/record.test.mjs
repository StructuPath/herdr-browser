import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	atomicWriteJson,
	inspectArtifact,
	main,
	MAX_RECORDING_BYTES,
	readJsonFile,
	validateRunId,
} from "../bin/record.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t, overrides = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-browser-record-"));
	const state = path.join(base, "state");
	const bin = path.join(base, "bin");
	const config = path.join(base, "config");
	const calls = path.join(base, "calls");
	fs.mkdirSync(bin);
	fs.mkdirSync(config);
	fs.writeFileSync(
		path.join(bin, "agent-browser"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AB_CALLS"
if [ "$4" = "start" ]; then
  if [ "${"$"}{AB_START_FAIL:-0}" = 1 ]; then
    [ -n "${"$"}{AB_ACTIVE:-}" ] && printf active > "$AB_ACTIVE"
    exit 9
  fi
  [ -n "${"$"}{AB_START_DELAY:-}" ] && sleep "$AB_START_DELAY"
  case "${"$"}{AB_ARTIFACT_MODE:-data}" in
    data) printf 'webm-test-data' > "$5" ;;
    empty) : > "$5" ;;
    missing) ;;
    symlink) ln -s "$AB_OUTSIDE" "$5" ;;
  esac
  [ -n "${"$"}{AB_ACTIVE:-}" ] && printf active > "$AB_ACTIVE"
else
  [ "${"$"}{AB_STOP_FAIL:-0}" = 1 ] && exit 8
  [ -n "${"$"}{AB_ACTIVE:-}" ] && rm -f "$AB_ACTIVE"
fi
exit 0
`,
		{ mode: 0o755 },
	);
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
		env: { ...f.env, ...overrides },
		encoding: "utf8",
	});
}

function invokeAsync(f, mode, overrides = {}) {
	return new Promise((resolve) => {
		const child = spawn("bash", [path.join(root, "scripts/record.sh"), mode], {
			env: { ...f.env, ...overrides },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

function bundle(f, runId = "suite-run-1", workspaceId = "workspace_1") {
	const dir = path.join(f.state, "runs", `run-${runId}`, "browser");
	return {
		dir,
		manifest: path.join(dir, "evidence.json"),
		artifact: path.join(dir, "recording.webm"),
		pointer: path.join(f.state, "runs", `active-${workspaceId}.json`),
	};
}

function json(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

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
	assert.match(
		fs.readFileSync(f.calls, "utf8"),
		/--session browser-session record start .*recording\.webm/,
	);
	assert.equal(fs.statSync(b.dir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(b.manifest).mode & 0o777, 0o600);
	assert.equal(fs.statSync(b.pointer).mode & 0o777, 0o600);
	assert.equal(fs.statSync(b.artifact).mode & 0o777, 0o600);
	const stop = invoke(f, "stop");
	assert.equal(stop.status, 0, stop.stderr);
	const complete = json(b.manifest);
	assert.equal(complete.status, "complete");
	assert.equal(complete.artifact.bytes, 14);
	assert.equal(
		complete.artifact.sha256,
		crypto.createHash("sha256").update("webm-test-data").digest("hex"),
	);
	assert.equal(complete.review.attestation, "none");
	assert.equal(fs.existsSync(b.pointer), false);
	assert.equal(fs.statSync(b.artifact).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(legacy, "utf8"), "legacy");
});

test("invalid, traversal, control, and oversized run IDs fail before the engine", (t) => {
	for (const id of [
		"../escape",
		"bad/name",
		"bad\nname",
		`a${"x".repeat(128)}`,
	])
		assert.throws(() => validateRunId(id));
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
	const first = fixture(t, {
		HERDR_BROWSER_RUN_ID: "",
		HERDR_WORKSPACE_ID: "a",
	});
	const second = fixture(t, {
		HERDR_BROWSER_RUN_ID: "",
		HERDR_WORKSPACE_ID: "b",
	});
	assert.equal(invoke(first, "start").status, 0);
	assert.equal(invoke(second, "start").status, 0);
	const id1 = fs
		.readdirSync(path.join(first.state, "runs"))
		.find((name) => name.startsWith("run-"))
		.slice(4);
	const id2 = fs
		.readdirSync(path.join(second.state, "runs"))
		.find((name) => name.startsWith("run-"))
		.slice(4);
	assert.equal(validateRunId(id1), id1);
	assert.notEqual(id1, id2);
});

test("session text never participates in paths and stop uses the pinned session", (t) => {
	const f = fixture(t, { HERDR_BROWSER_SESSION: "../../escape" });
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	assert.equal(json(b.manifest).browser_session, "../../escape");
	const stopped = invoke(f, "stop", {
		HERDR_BROWSER_SESSION: "changed-session",
		HERDR_BROWSER_RUN_ID: "changed-run",
	});
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
		[
			"directory",
			(b) => {
				fs.rmSync(b.artifact);
				fs.mkdirSync(b.artifact);
			},
		],
		[
			"symlink",
			(b, f) => {
				fs.rmSync(b.artifact);
				fs.symlinkSync(path.join(f.base, "outside"), b.artifact);
			},
		],
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

function writeLockOwner(f, value) {
	const runs = path.join(f.state, "runs");
	const lock = path.join(runs, ".record-workspace_1.lock");
	fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(lock, "owner.json"),
		`${JSON.stringify(value)}\n`,
		{
			mode: 0o600,
		},
	);
	return lock;
}

function validLockOwner(pid) {
	return {
		schema_version: 1,
		pid,
		hostname: os.hostname(),
		started_at: new Date().toISOString(),
		nonce: "a".repeat(32),
	};
}

test("Stop rejects every incompatible pointer and manifest field before engine side effects", async (t) => {
	const mutations = [
		["pointer schema", "pointer", (value) => (value.schema_version = 999)],
		["pointer unknown field", "pointer", (value) => (value.extra = true)],
		["pointer run", "pointer", (value) => (value.run_id = "foreign-run")],
		[
			"pointer workspace",
			"pointer",
			(value) => (value.workspace_id = "foreign"),
		],
		[
			"pointer session",
			"pointer",
			(value) => (value.browser_session = "foreign"),
		],
		[
			"pointer stop flag",
			"pointer",
			(value) => (value.engine_stopped = "false"),
		],
		["manifest schema", "manifest", (value) => (value.schema_version = 999)],
		["manifest unknown field", "manifest", (value) => (value.extra = true)],
		[
			"manifest evidence type",
			"manifest",
			(value) => (value.evidence_type = "not-browser"),
		],
		["manifest run", "manifest", (value) => (value.run_id = "foreign-run")],
		["plugin id", "manifest", (value) => (value.plugin.id = "foreign")],
		["plugin version", "manifest", (value) => (value.plugin.version = "999")],
		[
			"plugin unknown field",
			"manifest",
			(value) => (value.plugin.extra = true),
		],
		[
			"manifest workspace",
			"manifest",
			(value) => (value.workspace_id = "foreign"),
		],
		[
			"manifest session",
			"manifest",
			(value) => (value.browser_session = "foreign"),
		],
		["manifest status", "manifest", (value) => (value.status = "failed")],
		[
			"start timestamp",
			"manifest",
			(value) => (value.started_at = "yesterday"),
		],
		[
			"premature completion timestamp",
			"manifest",
			(value) => (value.completed_at = new Date().toISOString()),
		],
		[
			"context reset",
			"manifest",
			(value) => (value.recording_context_reset = false),
		],
		[
			"artifact path",
			"manifest",
			(value) => (value.artifact.path = "../../outside"),
		],
		[
			"artifact media",
			"manifest",
			(value) => (value.artifact.media_type = "text/plain"),
		],
		["artifact bytes", "manifest", (value) => (value.artifact.bytes = 14)],
		[
			"artifact digest",
			"manifest",
			(value) => (value.artifact.sha256 = "a".repeat(64)),
		],
		[
			"artifact unknown field",
			"manifest",
			(value) => (value.artifact.extra = true),
		],
		[
			"review status",
			"manifest",
			(value) => (value.review.status = "reviewed"),
		],
		["review required", "manifest", (value) => (value.review.required = false)],
		[
			"review attestation",
			"manifest",
			(value) => (value.review.attestation = "self-attested"),
		],
		[
			"review unknown field",
			"manifest",
			(value) => (value.review.extra = true),
		],
		[
			"error type",
			"manifest",
			(value) => (value.error = { message: "hostile" }),
		],
	];

	for (const [name, target, mutate] of mutations) {
		await t.test(name, (st) => {
			const f = fixture(st);
			assert.equal(invoke(f, "start").status, 0);
			const b = bundle(f);
			const file = target === "pointer" ? b.pointer : b.manifest;
			const value = json(file);
			mutate(value);
			fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
			const beforeFile = fs.readFileSync(file);
			const beforeCalls = fs.readFileSync(f.calls);
			const stopped = invoke(f, "stop");
			assert.equal(stopped.status, 3, name);
			assert.deepEqual(fs.readFileSync(file), beforeFile, name);
			assert.deepEqual(fs.readFileSync(f.calls), beforeCalls, name);
		});
	}
});

test("one run ID is atomically claimed across different workspaces", async (t) => {
	const f = fixture(t, { AB_START_DELAY: "0.2" });
	const [first, second] = await Promise.all([
		invokeAsync(f, "start", {
			HERDR_WORKSPACE_ID: "workspace_a",
			HERDR_BROWSER_SESSION: "session-a",
			HERDR_BROWSER_RUN_ID: "shared-run",
		}),
		invokeAsync(f, "start", {
			HERDR_WORKSPACE_ID: "workspace_b",
			HERDR_BROWSER_SESSION: "session-b",
			HERDR_BROWSER_RUN_ID: "shared-run",
		}),
	]);
	assert.deepEqual([first.status, second.status].sort(), [0, 3]);
	const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n");
	assert.equal(
		calls.filter((line) => line.includes(" record start ")).length,
		1,
	);
	const pointers = fs
		.readdirSync(path.join(f.state, "runs"))
		.filter((name) => name.startsWith("active-"));
	assert.equal(pointers.length, 1);
	const b = bundle(f, "shared-run");
	const manifest = json(b.manifest);
	assert.ok(["workspace_a", "workspace_b"].includes(manifest.workspace_id));
	assert.equal(
		manifest.browser_session,
		manifest.workspace_id === "workspace_a" ? "session-a" : "session-b",
	);
	assert.equal(fs.readFileSync(b.artifact, "utf8"), "webm-test-data");
});

test("failed post-start validation compensates and only then records terminal failure", (t) => {
	const f = fixture(t, {
		AB_ACTIVE: path.join(os.tmpdir(), `herdr-active-${crypto.randomUUID()}`),
		AB_ARTIFACT_MODE: "symlink",
		AB_OUTSIDE: path.join(os.tmpdir(), `herdr-outside-${crypto.randomUUID()}`),
	});
	fs.writeFileSync(f.env.AB_OUTSIDE, "outside", { mode: 0o644 });
	t.after(() => {
		fs.rmSync(f.env.AB_ACTIVE, { force: true });
		fs.rmSync(f.env.AB_OUTSIDE, { force: true });
	});
	const result = invoke(f, "start");
	assert.equal(result.status, 3);
	const b = bundle(f);
	assert.equal(json(b.manifest).status, "failed");
	assert.equal(fs.existsSync(b.pointer), false);
	assert.equal(fs.existsSync(f.env.AB_ACTIVE), false);
	assert.equal(fs.statSync(f.env.AB_OUTSIDE).mode & 0o777, 0o644);
	const calls = fs.readFileSync(f.calls, "utf8");
	assert.match(calls, /record start/);
	assert.match(calls, /record stop/);
});

test("failed compensation retains truthful retryable needs-attention state", (t) => {
	const outside = path.join(
		os.tmpdir(),
		`herdr-outside-${crypto.randomUUID()}`,
	);
	const active = path.join(os.tmpdir(), `herdr-active-${crypto.randomUUID()}`);
	const f = fixture(t, {
		AB_ACTIVE: active,
		AB_ARTIFACT_MODE: "symlink",
		AB_OUTSIDE: outside,
		AB_STOP_FAIL: "1",
	});
	fs.writeFileSync(outside, "outside");
	t.after(() => {
		fs.rmSync(active, { force: true });
		fs.rmSync(outside, { force: true });
	});
	const result = invoke(f, "start");
	assert.equal(result.status, 3);
	const b = bundle(f);
	assert.equal(json(b.manifest).status, "recording");
	assert.match(json(b.manifest).error, /needs attention/);
	assert.equal(fs.existsSync(b.pointer), true);
	assert.equal(fs.existsSync(active), true);
	fs.rmSync(b.artifact);
	fs.writeFileSync(b.artifact, "recovered-webm");
	const retry = invoke(f, "stop", { AB_STOP_FAIL: "0" });
	assert.equal(retry.status, 0, retry.stderr);
	assert.equal(json(b.manifest).status, "complete");
	assert.equal(fs.existsSync(active), false);
});

function withMainEnvironment(f, callback) {
	const values = {
		PATH: f.env.PATH,
		HERDR_BROWSER_STATE_DIR: f.state,
		HERDR_BROWSER_WORKSPACE_ID: "workspace_1",
		HERDR_BROWSER_SESSION_PINNED: "browser-session",
		HERDR_BROWSER_RUN_ID: f.env.HERDR_BROWSER_RUN_ID,
		HERDR_PLUGIN_CONFIG_DIR: f.config,
		AB_CALLS: f.calls,
	};
	const previous = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, values);
	try {
		return callback();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function failOperationNumber(f, method, number, message) {
	const original = fs[method];
	let calls = 0;
	fs[method] = (...args) => {
		calls++;
		if (calls === number) {
			const error = new Error(message);
			error.code = "EIO";
			throw error;
		}
		return original(...args);
	};
	try {
		assert.throws(
			() => withMainEnvironment(f, () => main("start")),
			new RegExp(message),
		);
	} finally {
		fs[method] = original;
	}
	return calls;
}

test("manifest and pointer write/fsync faults occur before the engine can start", async (t) => {
	for (const [name, method, operationNumber] of [
		["manifest write", "writeFileSync", 2],
		["pointer write", "writeFileSync", 3],
		["manifest fsync", "fsyncSync", 6],
		["pointer fsync", "fsyncSync", 8],
	]) {
		await t.test(name, (st) => {
			const runId = `fault-${name.replace(" ", "-")}`;
			const f = fixture(st, { HERDR_BROWSER_RUN_ID: runId });
			assert.ok(
				failOperationNumber(
					f,
					method,
					operationNumber,
					`injected ${name} failure`,
				) >= operationNumber,
			);
			assert.equal(fs.existsSync(f.calls), false);
			assert.equal(fs.existsSync(bundle(f, runId).pointer), false);
		});
	}
});

test("complete-manifest crash recovery verifies the artifact and unlinks without stopping twice", (t) => {
	const f = fixture(t);
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	const pointer = fs.readFileSync(b.pointer);
	assert.equal(invoke(f, "stop").status, 0);
	const calls = fs.readFileSync(f.calls);
	fs.writeFileSync(b.pointer, pointer, { mode: 0o600 });
	const recovered = invoke(f, "stop");
	assert.equal(recovered.status, 0, recovered.stderr);
	assert.equal(fs.existsSync(b.pointer), false);
	assert.deepEqual(fs.readFileSync(f.calls), calls);
	assert.equal(json(b.manifest).status, "complete");
});

test("complete recovery fails closed when the artifact no longer matches", (t) => {
	const f = fixture(t);
	assert.equal(invoke(f, "start").status, 0);
	const b = bundle(f);
	const pointer = fs.readFileSync(b.pointer);
	assert.equal(invoke(f, "stop").status, 0);
	fs.writeFileSync(b.pointer, pointer, { mode: 0o600 });
	fs.writeFileSync(b.artifact, "replacement");
	const calls = fs.readFileSync(f.calls);
	assert.equal(invoke(f, "stop").status, 3);
	assert.equal(fs.existsSync(b.pointer), true);
	assert.deepEqual(fs.readFileSync(f.calls), calls);
});

test("descriptor-based JSON validation detects coordinated pathname replacement", (t) => {
	const f = fixture(t);
	fs.mkdirSync(f.state, { mode: 0o700 });
	const canonical = fs.realpathSync(f.state);
	const target = path.join(canonical, "control.json");
	const held = path.join(canonical, "held.json");
	fs.writeFileSync(target, '{"generation":1}\n');
	assert.throws(
		() =>
			readJsonFile(canonical, target, "control JSON", {
				afterOpen() {
					fs.renameSync(target, held);
					fs.writeFileSync(target, '{"generation":2}\n');
				},
			}),
		/changed while/,
	);
});

test("artifact hash and chmod stay on one no-follow descriptor during replacement", (t) => {
	const f = fixture(t);
	fs.mkdirSync(f.state, { mode: 0o700 });
	const canonical = fs.realpathSync(f.state);
	const target = path.join(canonical, "recording.webm");
	const held = path.join(canonical, "held.webm");
	const outside = path.join(f.base, "outside.webm");
	fs.writeFileSync(target, "original", { mode: 0o644 });
	fs.writeFileSync(outside, "outside", { mode: 0o644 });
	assert.throws(
		() =>
			inspectArtifact(canonical, target, {
				afterOpen() {
					fs.renameSync(target, held);
					fs.symlinkSync(outside, target);
				},
			}),
		/changed while/,
	);
	assert.equal(fs.statSync(held).mode & 0o777, 0o600);
	assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
});

test("workspace locks fail closed for live and malformed owners", async (t) => {
	await t.test("live owner", (st) => {
		const f = fixture(st);
		writeLockOwner(f, validLockOwner(process.pid));
		const result = invoke(f, "start");
		assert.equal(result.status, 3);
		assert.match(result.stderr, /another recording action is in progress/);
		assert.equal(fs.existsSync(f.calls), false);
	});
	await t.test("malformed owner", (st) => {
		const f = fixture(st);
		const lock = writeLockOwner(f, { pid: 999999 });
		const result = invoke(f, "start");
		assert.equal(result.status, 3);
		assert.match(result.stderr, /cannot be safely reclaimed/);
		assert.match(
			result.stderr,
			/inspect .*\.record-workspace_1\.lock manually/,
		);
		assert.equal(fs.existsSync(lock), true);
		assert.equal(fs.existsSync(f.calls), false);
	});
});

test("well-formed locks are reclaimed only after their owner is proven dead", (t) => {
	const f = fixture(t);
	const lock = writeLockOwner(f, validLockOwner(2_147_483_647));
	const result = invoke(f, "start");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(lock), false);
	assert.equal(json(bundle(f).manifest).status, "recording");
});

test("concurrent stale-lock reclamation still permits only one workspace action", async (t) => {
	const f = fixture(t, { AB_START_DELAY: "0.2" });
	writeLockOwner(f, validLockOwner(2_147_483_647));
	const [first, second] = await Promise.all([
		invokeAsync(f, "start", { HERDR_BROWSER_RUN_ID: "reclaim-a" }),
		invokeAsync(f, "start", { HERDR_BROWSER_RUN_ID: "reclaim-b" }),
	]);
	assert.deepEqual([first.status, second.status].sort(), [0, 3]);
	const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n");
	assert.equal(
		calls.filter((line) => line.includes(" record start ")).length,
		1,
	);
	const pointers = fs
		.readdirSync(path.join(f.state, "runs"))
		.filter((name) => name.startsWith("active-"));
	assert.deepEqual(pointers, ["active-workspace_1.json"]);
});
