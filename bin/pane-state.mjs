// Pane state file: what the Browser pane observes, published for the coding
// agent beside it (read with bin/hb.mjs). Pure shaping plus atomic file I/O;
// the renderer decides when to publish. Schema changes bump the version.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PANE_STATE_SCHEMA_VERSION = 1;
export const PANE_STATE_TAIL = 20;
export const PANE_STATE_MAX_BYTES = 64 * 1024;
// url, title, session, endpoint. Four capped fields stay far under
// PANE_STATE_MAX_BYTES (<= 3 UTF-8 bytes per UTF-16 unit), so dropping tail
// lines always brings the file under the cap.
const MAX_FIELD = 2000;
const MAX_LINE = 500; // each console or failure line

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

// Whether host:port alone answers CDP discovery. Chrome's own browser
// endpoint (/devtools/browser/<id>: Puppeteer's wsEndpoint, DevToolsActivePort)
// shares its port with HTTP discovery; other WebSocket fronts (Playwright
// servers, hosted browsers, proxies) only work with the full URL.
function discoverable(url) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return null;
	}
	if (u.protocol === "http:" || u.protocol === "https:") return true;
	if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
	return /^\/devtools\/browser\/[^/]+$/.test(u.pathname) && !u.search;
}

// URLs leave the pane the way QA reports them (bin/qa.mjs safeUrl): no
// username, password, query, or fragment — those carry tokens. A data: URL
// is all payload; a blob: URL wraps an origin URL that is stripped in turn.
// Anything that does not parse is withheld rather than guessed at.
function safeHref(value) {
	let u;
	try {
		u = new URL(value);
	} catch {
		return "[unavailable URL]";
	}
	if (u.protocol === "data:") return "data:[redacted]";
	if (u.protocol === "blob:") {
		const inner = safeHref(u.pathname);
		return inner === "[unavailable URL]" ? "blob:[unavailable URL]" : `blob:${inner}`;
	}
	u.username = "";
	u.password = "";
	u.search = "";
	u.hash = "";
	return u.href;
}

// URLs inside free text (console, failed requests). A match runs to the next
// whitespace, and nothing else ends it: quotes, brackets, "<", ">", ";", and
// "…" can all sit inside a query or a data: payload, so stopping at any of
// them would leave the rest of a token behind. Sentence punctuation is given
// back only when the URL has no query or fragment to hide it in; with one,
// everything to the next whitespace is dropped (over-redaction is the safe
// side). A trailing "…" (truncate() marks a cut line with it) is kept.
// blob:/data: need a non-word char before them so "metadata:" is left alone.
const URL_IN_TEXT = /(?:(?:https?|wss?|file):\/\/|(?<![\w+.-])(?:blob|data):)\S+/gi;
export function redactUrls(text) {
	return String(text).replace(URL_IN_TEXT, (m) => {
		const cut = m.endsWith("…") ? "…" : "";
		let url = cut ? m.slice(0, -1) : m;
		let after = "";
		// data: is withheld whole, so there is no tail to give back.
		if (!/[?#]/.test(url) && !/^data:/i.test(url)) {
			const tail = /[.,;:!)\]}>'"]+$/.exec(url)?.[0] ?? "";
			url = url.slice(0, url.length - tail.length);
			after = tail;
		}
		return safeHref(url) + after + cut;
	});
}

// The page URL field: one URL of any scheme, "" before any page, or
// "[unavailable URL]".
export function redactUrl(value) {
	const s = String(value ?? "");
	return s === "" ? "" : safeHref(s);
}

// Cut at max UTF-16 units without splitting a surrogate pair.
function clip(s, max) {
	if (s.length <= max) return s;
	const code = s.charCodeAt(max - 1);
	return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

const text = (s, sanitize, max = MAX_FIELD) => (s == null ? "" : clip(sanitize(String(s)), max));
const tail = (lines, sanitize) =>
	(Array.isArray(lines) ? lines : [])
		.slice(-PANE_STATE_TAIL)
		.map((l) => clip(redactUrls(sanitize(String(l ?? ""))), MAX_LINE));

const serialize = (state) => `${JSON.stringify(state, null, 2)}\n`;

// Field order is the documented schema order. sanitize is the renderer's
// sanitizeText: page-controlled strings are re-stripped here so a caller that
// forgets cannot put terminal escapes in front of an agent that prints them.
// Strings are capped and URLs redacted; when the file would still exceed
// PANE_STATE_MAX_BYTES, the oldest tail lines go first.
export function buildPaneState(input, sanitize) {
	const backend = input.backend ?? "agent-browser";
	const state = {
		schemaVersion: PANE_STATE_SCHEMA_VERSION,
		backend,
		session: input.session == null ? null : text(input.session, sanitize),
		endpoint:
			backend === "agent-browser" ? null : clip(endpointHostPort(input.endpoint) ?? "", MAX_FIELD) || null,
		// Whether host:port alone reaches the browser; the capability path a
		// raw WebSocket front needs never leaves the pane.
		endpointDiscoverable:
			backend === "agent-browser" ? null : discoverable(input.endpoint),
		attached: Boolean(input.attached),
		url: clip(redactUrl(text(input.url, sanitize, Infinity)), MAX_FIELD),
		title: text(input.title, sanitize),
		observeOnly: Boolean(input.observeOnly),
		consoleTail: tail(input.consoleLines, sanitize),
		failures: tail(input.failures, sanitize),
		updatedAt: (input.now ?? new Date()).toISOString(),
		pid: input.pid,
	};
	const { consoleTail: c, failures: f } = state;
	while (c.length + f.length > 0 && Buffer.byteLength(serialize(state)) > PANE_STATE_MAX_BYTES)
		(c.length >= f.length ? c : f).shift();
	return state;
}

// Change detection ignores the timestamp: only observable state counts.
export function paneStateKey(state) {
	return JSON.stringify({ ...state, updatedAt: undefined });
}

// Temp + rename so a reader never sees a half-written file. The temp name
// is unpredictable and created exclusively (never through a symlink, never
// reusing a file someone left there); fchmod because the open mode is
// umask-relaxed.
export function writePaneState(file, state) {
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
	const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, serialize(state));
		fs.closeSync(fd);
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

// Exit cleanup: delete the file only while it is still this process's. A
// newer pane for the same workspace may have replaced it. Not atomic; a
// pane whose file vanishes in that gap writes it again on its next step
// (the renderer re-publishes when its file is missing).
export function removePaneStateIfOwned(file, pid) {
	try {
		if (JSON.parse(fs.readFileSync(file, "utf8"))?.pid === pid) fs.unlinkSync(file);
	} catch {
		/* missing, unreadable, or not ours */
	}
}

const isStr = (v) => typeof v === "string";
const isStrList = (v) => Array.isArray(v) && v.every(isStr);
const FIELD_CHECKS = {
	schemaVersion: (v) => v === PANE_STATE_SCHEMA_VERSION,
	backend: isStr,
	session: (v) => v === null || isStr(v),
	endpoint: (v) => v === null || isStr(v),
	// Added within v1: files from an older writer simply lack it.
	endpointDiscoverable: (v) => v === undefined || v === null || typeof v === "boolean",
	attached: (v) => typeof v === "boolean",
	url: isStr,
	title: isStr,
	observeOnly: (v) => typeof v === "boolean",
	consoleTail: isStrList,
	failures: isStrList,
	updatedAt: isStr,
	pid: Number.isInteger,
};

// null when there is no file; throws on unreadable, corrupt, or non-v1
// content (checked before any pid test, so `{}` is an error, not no-pane).
export function readPaneState(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
	const state = JSON.parse(raw);
	if (state === null || typeof state !== "object" || Array.isArray(state))
		throw new Error("pane state is not a JSON object");
	for (const [k, ok] of Object.entries(FIELD_CHECKS))
		if (!ok(state[k])) throw new Error(`pane state is not schema v${PANE_STATE_SCHEMA_VERSION}: bad ${k}`);
	return state;
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
