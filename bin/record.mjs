#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "structupath.browser";
const PLUGIN_VERSION = "0.6.0";
const SCHEMA_VERSION = 1;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]+$/;
const LOCK_NONCE_RE = /^[a-f0-9]{32}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const JSON_LIMIT = 64 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
export const MAX_RECORDING_BYTES = 10 * 1024 * 1024 * 1024;

export function validateRunId(value) {
	if (typeof value !== "string" || !RUN_ID_RE.test(value)) {
		throw new Error(
			"run ID must be 1-128 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit",
		);
	}
	return value;
}

export function isContained(root, target) {
	const relative = path.relative(root, target);
	return (
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function safeError(error) {
	return String(error?.message ?? error)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.slice(0, 512);
}

function pathEntryExists(target) {
	try {
		fs.lstatSync(target);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function ensureDirectory(dir) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`unsafe state directory: ${dir}`);
	fs.chmodSync(dir, 0o700);
}

function canonicalState(rawState) {
	if (!path.isAbsolute(rawState))
		throw new Error("plugin state directory must be absolute");
	ensureDirectory(rawState);
	const root = fs.realpathSync(rawState);
	if (!path.isAbsolute(root))
		throw new Error("could not canonicalize plugin state directory");
	return root;
}

function assertSafeParent(root, target, kind) {
	if (!isContained(root, target))
		throw new Error(`${kind} escapes plugin state`);
	const parent = fs.realpathSync(path.dirname(target));
	if (parent !== root && !isContained(root, parent))
		throw new Error(`${kind} parent escapes plugin state`);
}

function syncDirectory(dir) {
	const fd = fs.openSync(dir, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function descriptorStat(fd) {
	return fs.fstatSync(fd, { bigint: true });
}

function sameDescriptorGeneration(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function assertPathMatchesDescriptor(target, descriptor, label) {
	const current = fs.lstatSync(target, { bigint: true });
	if (
		!current.isFile() ||
		current.isSymbolicLink() ||
		current.dev !== descriptor.dev ||
		current.ino !== descriptor.ino
	) {
		throw new Error(`${label} changed while it was being validated`);
	}
}

export function atomicWriteJson(root, target, value) {
	assertSafeParent(root, target, "JSON file");
	const data = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(data) > JSON_LIMIT)
		throw new Error("JSON document is too large");
	const temp = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
	);
	assertSafeParent(root, temp, "temporary JSON file");
	let fd;
	try {
		fd = fs.openSync(
			temp,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
			0o600,
		);
		fs.writeFileSync(fd, data, "utf8");
		fs.fchmodSync(fd, 0o600);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temp, target);
		syncDirectory(path.dirname(target));
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(temp);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
}

function readDescriptor(fd, size) {
	const data = Buffer.alloc(size);
	let offset = 0;
	while (offset < data.length) {
		const count = fs.readSync(fd, data, offset, data.length - offset, null);
		if (count === 0) throw new Error("file ended while it was being read");
		offset += count;
	}
	return data;
}

export function readJsonFile(root, target, label, hooks = {}) {
	assertSafeParent(root, target, label);
	if (NOFOLLOW === undefined)
		throw new Error("this platform cannot safely open state files");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
	try {
		const before = descriptorStat(fd);
		if (!before.isFile() || before.size > BigInt(JSON_LIMIT))
			throw new Error(`${label} must be a bounded regular file`);
		hooks.afterOpen?.();
		const parsed = JSON.parse(
			readDescriptor(fd, Number(before.size)).toString("utf8"),
		);
		const after = descriptorStat(fd);
		if (!sameDescriptorGeneration(before, after))
			throw new Error(`${label} changed while it was being read`);
		assertPathMatchesDescriptor(target, after, label);
		return parsed;
	} finally {
		fs.closeSync(fd);
	}
}

function runIdFromEnvironment() {
	if (
		process.env.HERDR_BROWSER_RUN_ID !== undefined &&
		process.env.HERDR_BROWSER_RUN_ID !== ""
	) {
		return validateRunId(process.env.HERDR_BROWSER_RUN_ID);
	}
	const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
	if (configDir) {
		const configRoot = fs.realpathSync(configDir);
		const source = path.join(configRoot, "run-id");
		if (pathEntryExists(source)) {
			const firstLine = readBoundedText(
				configRoot,
				source,
				"run-id config",
				1024,
			).split(/\r?\n/, 1)[0];
			if (firstLine) return validateRunId(firstLine);
		}
	}
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	return `browser-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function readBoundedText(root, target, label, limit) {
	assertSafeParent(root, target, label);
	if (NOFOLLOW === undefined)
		throw new Error("this platform cannot safely open state files");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
	try {
		const before = descriptorStat(fd);
		if (!before.isFile() || before.size > BigInt(limit))
			throw new Error(`${label} must be a bounded regular file`);
		const text = readDescriptor(fd, Number(before.size)).toString("utf8");
		const after = descriptorStat(fd);
		if (!sameDescriptorGeneration(before, after))
			throw new Error(`${label} changed while it was being read`);
		assertPathMatchesDescriptor(target, after, label);
		return text;
	} finally {
		fs.closeSync(fd);
	}
}

export function buildManifest({
	runId,
	workspaceId,
	session,
	startedAt = new Date().toISOString(),
}) {
	return {
		schema_version: SCHEMA_VERSION,
		evidence_type: "browser-recording",
		run_id: runId,
		plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
		workspace_id: workspaceId,
		browser_session: session,
		status: "recording",
		started_at: startedAt,
		completed_at: null,
		recording_context_reset: true,
		artifact: {
			path: "recording.webm",
			media_type: "video/webm",
			bytes: null,
			sha256: null,
		},
		review: { status: "unreviewed", required: true, attestation: "none" },
		error: null,
	};
}

function withPrivateUmask(callback) {
	const previous = process.umask(0o077);
	try {
		return callback();
	} finally {
		process.umask(previous);
	}
}

function engine(session, args) {
	const result = withPrivateUmask(() =>
		spawnSync("agent-browser", ["--session", session, "record", ...args], {
			stdio: ["ignore", "ignore", "pipe"],
			encoding: "utf8",
			timeout: 15_000,
			killSignal: "SIGKILL",
		}),
	);
	if (result.error || result.status !== 0) {
		throw new Error(
			result.error?.code === "ETIMEDOUT"
				? "agent-browser timed out"
				: result.stderr?.trim() || `agent-browser exited ${result.status}`,
		);
	}
}

function pathsFor(root, workspaceId, runId) {
	const runs = path.join(root, "runs");
	ensureDirectory(runs);
	const run = path.join(runs, `run-${runId}`);
	const bundle = path.join(run, "browser");
	return {
		runs,
		run,
		bundle,
		manifest: path.join(bundle, "evidence.json"),
		artifact: path.join(bundle, "recording.webm"),
		pointer: path.join(runs, `active-${workspaceId}.json`),
	};
}

function assertExactKeys(value, keys, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	)
		throw new Error(`${label} has incompatible fields`);
}

function assertIsoTimestamp(value, label) {
	if (
		typeof value !== "string" ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
	}
}

function assertErrorField(value) {
	if (
		value !== null &&
		(typeof value !== "string" ||
			value.length > 512 ||
			/[\u0000-\u001f\u007f]/.test(value))
	) {
		throw new Error("evidence manifest error is invalid");
	}
}

function validatePointer(pointer, identity) {
	assertExactKeys(
		pointer,
		[
			"schema_version",
			"run_id",
			"workspace_id",
			"browser_session",
			"engine_stopped",
		],
		"active recording pointer",
	);
	if (pointer.schema_version !== SCHEMA_VERSION)
		throw new Error("active recording pointer schema is incompatible");
	validateRunId(pointer.run_id);
	if (
		pointer.run_id !== identity.runId ||
		pointer.workspace_id !== identity.workspaceId ||
		typeof pointer.browser_session !== "string" ||
		!pointer.browser_session ||
		typeof pointer.engine_stopped !== "boolean"
	) {
		throw new Error("active recording pointer identity is invalid");
	}
}

function validateManifest(manifest, identity, expectedStatus) {
	assertExactKeys(
		manifest,
		[
			"schema_version",
			"evidence_type",
			"run_id",
			"plugin",
			"workspace_id",
			"browser_session",
			"status",
			"started_at",
			"completed_at",
			"recording_context_reset",
			"artifact",
			"review",
			"error",
		],
		"evidence manifest",
	);
	assertExactKeys(
		manifest.plugin,
		["id", "version"],
		"evidence manifest plugin",
	);
	assertExactKeys(
		manifest.artifact,
		["path", "media_type", "bytes", "sha256"],
		"evidence manifest artifact",
	);
	assertExactKeys(
		manifest.review,
		["status", "required", "attestation"],
		"evidence manifest review",
	);
	if (
		manifest.schema_version !== SCHEMA_VERSION ||
		manifest.evidence_type !== "browser-recording" ||
		manifest.run_id !== identity.runId ||
		manifest.plugin.id !== PLUGIN_ID ||
		manifest.plugin.version !== PLUGIN_VERSION ||
		manifest.workspace_id !== identity.workspaceId ||
		manifest.browser_session !== identity.session ||
		manifest.status !== expectedStatus ||
		manifest.recording_context_reset !== true ||
		manifest.artifact.path !== "recording.webm" ||
		manifest.artifact.media_type !== "video/webm" ||
		manifest.review.status !== "unreviewed" ||
		manifest.review.required !== true ||
		manifest.review.attestation !== "none"
	) {
		throw new Error("evidence manifest identity or contract is incompatible");
	}
	assertIsoTimestamp(manifest.started_at, "evidence manifest started_at");
	assertErrorField(manifest.error);
	if (expectedStatus === "recording") {
		if (
			manifest.completed_at !== null ||
			manifest.artifact.bytes !== null ||
			manifest.artifact.sha256 !== null
		) {
			throw new Error("recording evidence manifest has completion data");
		}
		return;
	}
	assertIsoTimestamp(manifest.completed_at, "evidence manifest completed_at");
	if (Date.parse(manifest.completed_at) < Date.parse(manifest.started_at))
		throw new Error("evidence manifest completion predates its start");
	if (
		!Number.isSafeInteger(manifest.artifact.bytes) ||
		manifest.artifact.bytes <= 0 ||
		manifest.artifact.bytes > MAX_RECORDING_BYTES ||
		!SHA256_RE.test(manifest.artifact.sha256) ||
		manifest.error !== null
	) {
		throw new Error("complete evidence manifest has invalid completion data");
	}
}

function lockOwner() {
	return {
		schema_version: SCHEMA_VERSION,
		pid: process.pid,
		hostname: os.hostname(),
		started_at: new Date().toISOString(),
		nonce: crypto.randomBytes(16).toString("hex"),
	};
}

function validateLockOwner(owner) {
	assertExactKeys(
		owner,
		["schema_version", "pid", "hostname", "started_at", "nonce"],
		"recording lock owner",
	);
	if (
		owner.schema_version !== SCHEMA_VERSION ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid <= 0 ||
		owner.hostname !== os.hostname() ||
		!LOCK_NONCE_RE.test(owner.nonce)
	) {
		throw new Error(
			"recording lock owner is malformed or belongs to another host",
		);
	}
	assertIsoTimestamp(owner.started_at, "recording lock started_at");
}

function processIsProvenDead(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		if (error.code === "ESRCH") return true;
		return false;
	}
}

function acquireWorkspaceLock(root, workspaceId) {
	const runs = path.join(root, "runs");
	ensureDirectory(runs);
	const lock = path.join(runs, `.record-${workspaceId}.lock`);
	const ownerPath = path.join(lock, "owner.json");
	assertSafeParent(root, lock, "recording lock");
	for (;;) {
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			const owner = lockOwner();
			try {
				atomicWriteJson(root, ownerPath, owner);
				syncDirectory(runs);
				return { lock, ownerPath, owner, runs };
			} catch (error) {
				fs.rmSync(lock, { recursive: true, force: true });
				syncDirectory(runs);
				throw error;
			}
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}

		let owner;
		try {
			owner = readJsonFile(root, ownerPath, "recording lock owner");
			validateLockOwner(owner);
		} catch (error) {
			throw new Error(
				`recording lock cannot be safely reclaimed: ${safeError(error)}; inspect ${lock} manually`,
			);
		}
		if (!processIsProvenDead(owner.pid))
			throw new Error(
				"another recording action is in progress for this workspace",
			);

		const tombstone = `${lock}.stale-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
		try {
			fs.renameSync(lock, tombstone);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		fs.rmSync(tombstone, { recursive: true, force: true });
		syncDirectory(runs);
	}
}

function releaseWorkspaceLock(root, held) {
	const current = readJsonFile(root, held.ownerPath, "recording lock owner");
	validateLockOwner(current);
	if (current.nonce !== held.owner.nonce || current.pid !== held.owner.pid)
		throw new Error("recording lock ownership changed unexpectedly");
	fs.rmSync(held.lock, { recursive: true });
	syncDirectory(held.runs);
}

function withWorkspaceLock(root, workspaceId, callback) {
	const held = acquireWorkspaceLock(root, workspaceId);
	try {
		return callback();
	} finally {
		releaseWorkspaceLock(root, held);
	}
}

function claimRun(paths, runId) {
	try {
		fs.mkdirSync(paths.run, { mode: 0o700 });
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(`recording bundle already exists for run ${runId}`);
		throw error;
	}
	syncDirectory(paths.runs);
	fs.mkdirSync(paths.bundle, { mode: 0o700 });
	syncDirectory(paths.run);
}

function durableUnlink(target, parent) {
	fs.unlinkSync(target);
	syncDirectory(parent);
}

function pointerFor(runId, workspaceId, session) {
	return {
		schema_version: SCHEMA_VERSION,
		run_id: runId,
		workspace_id: workspaceId,
		browser_session: session,
		engine_stopped: false,
	};
}

function privatizeArtifactIfPresent(root, target) {
	assertSafeParent(root, target, "recording artifact");
	if (!pathEntryExists(target)) return;
	if (NOFOLLOW === undefined)
		throw new Error("this platform cannot safely open recording artifacts");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
	try {
		const stat = descriptorStat(fd);
		if (!stat.isFile())
			throw new Error("recording artifact must be a regular file");
		fs.fchmodSync(fd, 0o600);
		assertPathMatchesDescriptor(
			target,
			descriptorStat(fd),
			"recording artifact",
		);
	} finally {
		fs.closeSync(fd);
	}
}

export function inspectArtifact(root, target, hooks = {}) {
	assertSafeParent(root, target, "recording artifact");
	if (NOFOLLOW === undefined)
		throw new Error("this platform cannot safely open recording artifacts");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
	try {
		let before = descriptorStat(fd);
		if (!before.isFile())
			throw new Error("recording artifact must be a regular file");
		if (before.size === 0n) throw new Error("recording artifact is empty");
		if (before.size > BigInt(MAX_RECORDING_BYTES))
			throw new Error("recording artifact exceeds the 10 GiB limit");
		fs.fchmodSync(fd, 0o600);
		before = descriptorStat(fd);
		hooks.afterOpen?.();
		const hash = crypto.createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let bytes = 0;
		for (;;) {
			const count = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (count === 0) break;
			bytes += count;
			hash.update(buffer.subarray(0, count));
		}
		const after = descriptorStat(fd);
		if (
			!sameDescriptorGeneration(before, after) ||
			BigInt(bytes) !== after.size
		) {
			throw new Error("recording artifact changed while it was being hashed");
		}
		assertPathMatchesDescriptor(target, after, "recording artifact");
		return { bytes, sha256: hash.digest("hex") };
	} finally {
		fs.closeSync(fd);
	}
}

export function sha256File(file) {
	const root = fs.realpathSync(path.dirname(file));
	return inspectArtifact(root, file).sha256;
}

function context() {
	const root = canonicalState(process.env.HERDR_BROWSER_STATE_DIR ?? "");
	const workspaceId = process.env.HERDR_BROWSER_WORKSPACE_ID ?? "";
	if (!WORKSPACE_ID_RE.test(workspaceId))
		throw new Error("invalid workspace ID");
	const session = process.env.HERDR_BROWSER_SESSION_PINNED ?? "";
	if (!session) throw new Error("browser session is required");
	return { root, workspaceId, session };
}

function recordRetryError(root, manifestPath, manifest, error) {
	manifest.status = "recording";
	manifest.completed_at = null;
	manifest.artifact.bytes = null;
	manifest.artifact.sha256 = null;
	manifest.error = safeError(error);
	atomicWriteJson(root, manifestPath, manifest);
}

function start() {
	const { root, workspaceId, session } = context();
	const runId = runIdFromEnvironment();
	const paths = pathsFor(root, workspaceId, runId);
	return withWorkspaceLock(root, workspaceId, () => {
		if (pathEntryExists(paths.pointer))
			throw new Error("a recording is already active for this workspace");
		claimRun(paths, runId);
		const manifest = buildManifest({ runId, workspaceId, session });
		const pointer = pointerFor(runId, workspaceId, session);
		try {
			atomicWriteJson(root, paths.manifest, manifest);
			atomicWriteJson(root, paths.pointer, pointer);
		} catch (error) {
			manifest.status = "failed";
			manifest.error = safeError(error);
			try {
				atomicWriteJson(root, paths.manifest, manifest);
			} catch {
				// The original recording journal, if published, remains conservative.
			}
			if (pathEntryExists(paths.pointer)) {
				try {
					durableUnlink(paths.pointer, paths.runs);
				} catch {
					// No engine side effect occurred; refuse rather than delete ambiguity.
				}
			}
			throw error;
		}

		try {
			engine(session, ["start", paths.artifact]);
			privatizeArtifactIfPresent(root, paths.artifact);
		} catch (startError) {
			let compensationError;
			try {
				engine(session, ["stop"]);
			} catch (error) {
				compensationError = error;
			}
			if (compensationError) {
				const attention = new Error(
					`recording start needs attention: ${safeError(startError)}; compensating stop failed: ${safeError(compensationError)}`,
				);
				try {
					recordRetryError(root, paths.manifest, manifest, attention);
				} catch {
					// The durable pre-engine journal and pointer remain retryable.
				}
				throw attention;
			}
			pointer.engine_stopped = true;
			atomicWriteJson(root, paths.pointer, pointer);
			manifest.status = "failed";
			manifest.error = safeError(startError);
			atomicWriteJson(root, paths.manifest, manifest);
			durableUnlink(paths.pointer, paths.runs);
			throw startError;
		}
		console.log(
			`herdr-browser: recording run_id=${runId} manifest=${paths.manifest}`,
		);
	});
}

function recoverComplete(root, paths, pointer, manifest) {
	const artifact = inspectArtifact(root, paths.artifact);
	if (
		artifact.bytes !== manifest.artifact.bytes ||
		artifact.sha256 !== manifest.artifact.sha256
	) {
		throw new Error(
			"completed recording artifact no longer matches its manifest",
		);
	}
	durableUnlink(paths.pointer, paths.runs);
	console.log(
		`herdr-browser: completed run_id=${pointer.run_id} manifest=${paths.manifest}`,
	);
}

function stop() {
	const { root, workspaceId } = context();
	return withWorkspaceLock(root, workspaceId, () => {
		const pointerPath = path.join(root, "runs", `active-${workspaceId}.json`);
		if (!pathEntryExists(pointerPath))
			throw new Error("no recording is active for this workspace");
		const pointer = readJsonFile(root, pointerPath, "active recording pointer");
		validateRunId(pointer.run_id);
		const paths = pathsFor(root, workspaceId, pointer.run_id);
		const manifest = readJsonFile(root, paths.manifest, "evidence manifest");
		const identity = {
			runId: pointer.run_id,
			workspaceId,
			session: pointer.browser_session,
		};
		validatePointer(pointer, identity);

		if (manifest.status === "complete") {
			validateManifest(manifest, identity, "complete");
			recoverComplete(root, paths, pointer, manifest);
			return;
		}
		validateManifest(manifest, identity, "recording");

		let artifact;
		try {
			if (!pointer.engine_stopped) {
				engine(pointer.browser_session, ["stop"]);
				pointer.engine_stopped = true;
				atomicWriteJson(root, paths.pointer, pointer);
			}
			artifact = inspectArtifact(root, paths.artifact);
		} catch (error) {
			recordRetryError(root, paths.manifest, manifest, error);
			throw error;
		}

		manifest.status = "complete";
		manifest.completed_at = new Date().toISOString();
		manifest.artifact.bytes = artifact.bytes;
		manifest.artifact.sha256 = artifact.sha256;
		manifest.error = null;
		try {
			atomicWriteJson(root, paths.manifest, manifest);
		} catch (error) {
			let published = false;
			try {
				const current = readJsonFile(root, paths.manifest, "evidence manifest");
				validateManifest(current, identity, "complete");
				published =
					current.artifact.bytes === artifact.bytes &&
					current.artifact.sha256 === artifact.sha256;
			} catch {
				// Keep the recording generation retryable below.
			}
			if (!published) {
				manifest.status = "recording";
				manifest.completed_at = null;
				manifest.artifact.bytes = null;
				manifest.artifact.sha256 = null;
				recordRetryError(root, paths.manifest, manifest, error);
			}
			throw error;
		}
		durableUnlink(paths.pointer, paths.runs);
		console.log(
			`herdr-browser: completed run_id=${pointer.run_id} manifest=${paths.manifest}`,
		);
	});
}

export function main(mode = process.argv[2]) {
	if (mode === "start") return start();
	if (mode === "stop") return stop();
	throw new Error("usage: record.mjs start|stop");
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		main();
	} catch (error) {
		console.error(`herdr-browser: ${safeError(error)}`);
		process.exitCode = 3;
	}
}
