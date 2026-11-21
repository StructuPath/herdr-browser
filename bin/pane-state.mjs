// Pane state file: what the Browser pane observes, published for the coding
// agent beside it (read with bin/hb.mjs). Pure shaping plus atomic file I/O;
// the renderer decides when to publish. Schema changes bump the version.
import fs from "node:fs";
import path from "node:path";

export const PANE_STATE_SCHEMA_VERSION = 1;
export const PANE_STATE_TAIL = 20;

export function paneStateFile(stateDir, wsId) {
	return path.join(stateDir, `pane-${wsId}.json`);
}

// Endpoint URLs carry capability tokens in their path (/devtools/browser/<id>,
// ?token=…): only host:port may leave the pane. A missing port is filled with
// the one the pane actually dials (cdp.mjs discovers http(s) on 9222).
export function endpointHostPort(url) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return null;
	}
	const defaults = { "http:": "9222", "https:": "9222", "ws:": "80", "wss:": "443" };
	if (!(u.protocol in defaults) || !u.hostname) return null;
	return `${u.hostname}:${u.port || defaults[u.protocol]}`;
}

const text = (s, sanitize) => (s == null ? "" : sanitize(String(s)));
const tail = (lines, sanitize) =>
	(Array.isArray(lines) ? lines : [])
		.slice(-PANE_STATE_TAIL)
		.map((l) => text(l, sanitize));

// Field order is the documented schema order. sanitize is the renderer's
// sanitizeText: page-controlled strings are re-stripped here so a caller that
// forgets cannot put terminal escapes in front of an agent that prints them.
export function buildPaneState(input, sanitize) {
	const backend = input.backend ?? "agent-browser";
	return {
		schemaVersion: PANE_STATE_SCHEMA_VERSION,
		backend,
		session: input.session == null ? null : text(input.session, sanitize),
		endpoint:
			backend === "agent-browser" ? null : endpointHostPort(input.endpoint),
		attached: Boolean(input.attached),
		url: text(input.url, sanitize),
		title: text(input.title, sanitize),
		observeOnly: Boolean(input.observeOnly),
		consoleTail: tail(input.consoleLines, sanitize),
		failures: tail(input.failures, sanitize),
		updatedAt: (input.now ?? new Date()).toISOString(),
		pid: input.pid,
	};
}

// Change detection ignores the timestamp: only observable state counts.
export function paneStateKey(state) {
	return JSON.stringify({ ...state, updatedAt: undefined });
}

// Temp + rename so a reader never sees a half-written file. writeFileSync's
// mode applies only on creation and is umask-relaxed: chmod explicitly.
export function writePaneState(file, state) {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* never created */
		}
		throw err;
	}
}

// null when there is no file; throws on unreadable or corrupt content.
export function readPaneState(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
	return JSON.parse(raw);
}

// EPERM means the pid exists under another user — still alive.
export function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}
