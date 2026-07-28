#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_VERSION = "0.6.0";
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JSON_LIMIT = 64 * 1024;
export const MAX_RECORDING_BYTES = 10 * 1024 * 1024 * 1024;

export function validateRunId(value) {
	if (typeof value !== "string" || !RUN_ID_RE.test(value)) {
		throw new Error("run ID must be 1-128 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit");
	}
	return value;
}

export function isContained(root, target) {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeError(error) {
	return String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

function ensureDirectory(dir) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe state directory: ${dir}`);
	fs.chmodSync(dir, 0o700);
}

function canonicalState(rawState) {
	if (!path.isAbsolute(rawState)) throw new Error("plugin state directory must be absolute");
	ensureDirectory(rawState);
	const root = fs.realpathSync(rawState);
	if (!path.isAbsolute(root)) throw new Error("could not canonicalize plugin state directory");
	return root;
}

function assertSafeTarget(root, target, kind = "file") {
	if (!isContained(root, target)) throw new Error(`${kind} escapes plugin state`);
	const parent = fs.realpathSync(path.dirname(target));
	if (!isContained(root, parent) && parent !== root) throw new Error(`${kind} parent escapes plugin state`);
	if (fs.existsSync(target)) {
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink()) throw new Error(`${kind} must not be a symlink`);
		if (kind.includes("JSON") && !stat.isFile()) throw new Error(`${kind} must be a regular file`);
	}
}

export function atomicWriteJson(root, target, value) {
	assertSafeTarget(root, target, "JSON file");
	const data = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(data) > JSON_LIMIT) throw new Error("JSON document is too large");
	const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	assertSafeTarget(root, temp, "temporary JSON file");
	let fd;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(fd, data, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temp, target);
		fs.chmodSync(target, 0o600);
		const dirFd = fs.openSync(path.dirname(target), "r");
		try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
	}
}

function readJsonFile(root, target, label) {
	assertSafeTarget(root, target, label);
	const stat = fs.lstatSync(target);
	if (!stat.isFile() || stat.size > JSON_LIMIT) throw new Error(`${label} must be a bounded regular file`);
	return JSON.parse(fs.readFileSync(target, "utf8"));
}

function runIdFromEnvironment() {
	if (process.env.HERDR_BROWSER_RUN_ID !== undefined && process.env.HERDR_BROWSER_RUN_ID !== "") {
		return validateRunId(process.env.HERDR_BROWSER_RUN_ID);
	}
	const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
	if (configDir) {
		const source = path.join(configDir, "run-id");
		if (fs.existsSync(source)) {
			const stat = fs.lstatSync(source);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("run-id config must be a bounded regular file");
			const firstLine = fs.readFileSync(source, "utf8").split(/\r?\n/, 1)[0];
			if (firstLine) return validateRunId(firstLine);
		}
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return `browser-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

export function buildManifest({ runId, workspaceId, session, startedAt = new Date().toISOString() }) {
	return {
		schema_version: 1,
		evidence_type: "browser-recording",
		run_id: runId,
		plugin: { id: "structupath.browser", version: PLUGIN_VERSION },
		workspace_id: workspaceId,
		browser_session: session,
		status: "recording",
		started_at: startedAt,
		completed_at: null,
		recording_context_reset: true,
		artifact: { path: "recording.webm", media_type: "video/webm", bytes: null, sha256: null },
		review: { status: "unreviewed", required: true, attestation: "none" },
		error: null,
	};
}

function engine(session, args) {
	const result = spawnSync("agent-browser", ["--session", session, "record", ...args], {
		stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
	});
	if (result.error || result.status !== 0) {
		throw new Error(result.error?.code === "ETIMEDOUT" ? "agent-browser timed out" : result.stderr?.trim() || `agent-browser exited ${result.status}`);
	}
}

function pathsFor(root, workspaceId, runId) {
	const runs = path.join(root, "runs");
	ensureDirectory(runs);
	const bundle = path.join(runs, `run-${runId}`, "browser");
	const pointer = path.join(runs, `active-${workspaceId}.json`);
	return { runs, bundle, manifest: path.join(bundle, "evidence.json"), artifact: path.join(bundle, "recording.webm"), pointer };
}

function withWorkspaceLock(root, workspaceId, callback) {
	const lock = path.join(root, "runs", `.record-${workspaceId}.lock`);
	assertSafeTarget(root, lock, "recording lock");
	try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
		if (error.code === "EEXIST") throw new Error("another recording action is in progress for this workspace");
		throw error;
	}
	try { return callback(); } finally { fs.rmdirSync(lock); }
}

export function sha256File(file) {
	const hash = crypto.createHash("sha256");
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); }
	} finally { fs.closeSync(fd); }
	return hash.digest("hex");
}

function context() {
	const root = canonicalState(process.env.HERDR_BROWSER_STATE_DIR ?? "");
	const workspaceId = process.env.HERDR_BROWSER_WORKSPACE_ID ?? "";
	if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error("invalid workspace ID");
	const session = process.env.HERDR_BROWSER_SESSION_PINNED ?? "";
	if (!session) throw new Error("browser session is required");
	return { root, workspaceId, session };
}

function start() {
	const { root, workspaceId, session } = context();
	const runId = runIdFromEnvironment();
	const paths = pathsFor(root, workspaceId, runId);
	return withWorkspaceLock(root, workspaceId, () => {
		if (fs.existsSync(paths.pointer)) throw new Error("a recording is already active for this workspace");
		if (fs.existsSync(path.join(paths.runs, `run-${runId}`))) throw new Error(`recording bundle already exists for run ${runId}`);
		ensureDirectory(path.dirname(paths.bundle));
		ensureDirectory(paths.bundle);
		const manifest = buildManifest({ runId, workspaceId, session });
		try {
			engine(session, ["start", paths.artifact]);
			atomicWriteJson(root, paths.manifest, manifest);
			atomicWriteJson(root, paths.pointer, { schema_version: 1, run_id: runId, workspace_id: workspaceId, browser_session: session, engine_stopped: false });
		} catch (error) {
			manifest.status = "failed";
			manifest.error = safeError(error);
			atomicWriteJson(root, paths.manifest, manifest);
			throw error;
		}
		console.log(`herdr-browser: recording run_id=${runId} manifest=${paths.manifest}`);
	});
}

function stop() {
	const { root, workspaceId } = context();
	return withWorkspaceLock(root, workspaceId, () => {
		const pointerPath = path.join(root, "runs", `active-${workspaceId}.json`);
		if (!fs.existsSync(pointerPath)) throw new Error("no recording is active for this workspace");
		const pointer = readJsonFile(root, pointerPath, "active recording pointer");
		validateRunId(pointer.run_id);
		if (pointer.workspace_id !== workspaceId || typeof pointer.browser_session !== "string" || !pointer.browser_session || typeof pointer.engine_stopped !== "boolean") throw new Error("active recording pointer is invalid");
		const paths = pathsFor(root, workspaceId, pointer.run_id);
		const manifest = readJsonFile(root, paths.manifest, "evidence manifest");
		if (manifest.status !== "recording" || manifest.run_id !== pointer.run_id || manifest.browser_session !== pointer.browser_session) throw new Error("active recording state is inconsistent");
		try {
			if (!pointer.engine_stopped) {
				engine(pointer.browser_session, ["stop"]);
				pointer.engine_stopped = true;
				atomicWriteJson(root, paths.pointer, pointer);
			}
			assertSafeTarget(root, paths.artifact, "recording artifact");
			const stat = fs.lstatSync(paths.artifact);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("recording artifact must be a regular file");
			if (stat.size === 0) throw new Error("recording artifact is empty");
			if (stat.size > MAX_RECORDING_BYTES) throw new Error("recording artifact exceeds the 10 GiB limit");
			fs.chmodSync(paths.artifact, 0o600);
			manifest.status = "complete";
			manifest.completed_at = new Date().toISOString();
			manifest.artifact.bytes = stat.size;
			manifest.artifact.sha256 = sha256File(paths.artifact);
			manifest.error = null;
			atomicWriteJson(root, paths.manifest, manifest);
			fs.unlinkSync(paths.pointer);
		} catch (error) {
			manifest.status = "recording";
			manifest.completed_at = null;
			manifest.artifact.bytes = null;
			manifest.artifact.sha256 = null;
			manifest.error = safeError(error);
			atomicWriteJson(root, paths.manifest, manifest);
			throw error;
		}
		console.log(`herdr-browser: completed run_id=${pointer.run_id} manifest=${paths.manifest}`);
	});
}

export function main(mode = process.argv[2]) {
	if (mode === "start") return start();
	if (mode === "stop") return stop();
	throw new Error("usage: record.mjs start|stop");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); } catch (error) { console.error(`herdr-browser: ${safeError(error)}`); process.exitCode = 3; }
}
