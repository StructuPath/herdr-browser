#!/usr/bin/env node
// herdr-browser pane renderer: an attached view of an agent-browser session.
// It stays passive until explicit pane input, never clears the console buffer,
// and closes only sessions that its own successful navigation created.
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { makeCdpBrowser, cdpSupported, redactWsUrl } from "./cdp.mjs";

const pExecFile = promisify(execFile);
const ESC = "\x1b";
// Fixed graphics id for the pane's screenshot frame: re-transmitting data
// for an id auto-replaces the previous frame, and deletes target only our
// image instead of every image in the terminal (d=A).
const KITTY_IMAGE_ID = 1;
// chafa emits anonymous kitty placements (no id), and full repaints/cleanup
// must clear everything — our id-addressed frames included.
const KITTY_DELETE_ALL = `${ESC}_Ga=d,d=A${ESC}\\`;

// --- pure helpers (unit-tested) ---

// Workspace ids become file names (locks, pane-id files, screenshots) and
// one lock path is subject to an rm -rf in open.sh's lock steal — only a
// strict charset may pass. Must stay in lockstep with ws_id() in lib.sh.
export function safeWsId(id) {
	const s = String(id || "default").replace(/[^A-Za-z0-9_-]/g, "");
	return s || "default";
}

// Names flow into the terminal on every header repaint: strip whitespace and
// C0/C1 control chars from every source so ESC can never reach the screen.
const cleanName = (s) =>
	String(s).replace(/[\s\u0000-\u001f\u007f-\u009f]/g, "");

// Must stay in lockstep with session_name() in scripts/lib.sh.
export function deriveSession(env, cwd) {
	if (env.HERDR_BROWSER_SESSION) {
		const name = cleanName(env.HERDR_BROWSER_SESSION);
		if (name) return name;
	}
	if (env.HERDR_PLUGIN_CONFIG_DIR) {
		const f = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "session");
		if (fs.existsSync(f)) {
			const name = cleanName(fs.readFileSync(f, "utf8").split("\n")[0]);
			if (name) return name;
		}
	}
	if (env.HERDR_WORKSPACE_ID)
		return `herdr-ws-${safeWsId(env.HERDR_WORKSPACE_ID)}`;
	const res = spawnSync("sh", ["-c", "printf '%s\\n' \"$HB_CWD\" | cksum"], {
		env: { ...process.env, HB_CWD: cwd },
		timeout: 5000,
	});
	const sum = res.stdout ? res.stdout.toString().split(" ")[0].trim() : "";
	return `herdr-cwd-${sum || "unknown"}`;
}

// Console cursor reconciliation over agent-browser's 1000-entry ring buffer.
// prev: { count, tail } where tail is the last few entry texts we rendered.
// Returns { newEntries, marker } — marker signals an external clear or a
// rotation we could not align, so callers should show a discontinuity note.
export function reconcileConsole(prev, entries, ringSize = 1000) {
	if (!prev || prev.count === 0) return { newEntries: entries, marker: false };
	if (entries.length < prev.count) return { newEntries: entries, marker: true };
	if (prev.count < ringSize && entries.length >= prev.count) {
		const head = entries.slice(0, prev.count).map((e) => e.text);
		const aligned = prev.tail.every(
			(t, i) => head[prev.count - prev.tail.length + i] === t,
		);
		if (aligned)
			return { newEntries: entries.slice(prev.count), marker: false };
	}
	// Ring saturated (or head mismatch): find the latest occurrence of our tail
	// window in the new buffer and take what follows it. Rotation may have
	// evicted the window's head, so retry with progressively shorter suffixes.
	const texts = entries.map((e) => e.text);
	for (let winLen = prev.tail.length; winLen >= 1; winLen--) {
		const win = prev.tail.slice(prev.tail.length - winLen);
		for (let end = texts.length - 1; end >= winLen - 1; end--) {
			let match = true;
			for (let i = 0; i < winLen; i++) {
				if (texts[end - winLen + 1 + i] !== win[i]) {
					match = false;
					break;
				}
			}
			if (match) return { newEntries: entries.slice(end + 1), marker: false };
		}
	}
	return { newEntries: entries, marker: true };
}

export function consoleTail(entries, n = 8) {
	return entries.slice(-n).map((e) => e.text);
}

// Boolean knobs accept the common spellings; anything else is off.
export function truthyConfig(value) {
	return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

// Locate a launchable Chromium for launch mode (the l key). An explicit
// choice (env, then config file) is trusted as-is — it may name a binary
// that is not on PATH; probing covers the common names plus the macOS app
// bundles that never appear on PATH.
export function findChromium(env, configDirValue, probe) {
	const explicit = env.HERDR_BROWSER_CHROMIUM || configDirValue;
	if (explicit) return explicit;
	// google-chrome first: where it exists it is nearly always a real
	// binary, while "chromium" on Ubuntu is often a snap wrapper whose
	// confinement cannot read a profile directory outside $HOME — it then
	// never writes DevToolsActivePort and the launch times out.
	const candidates = [
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
		"chrome",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	];
	for (const c of candidates) if (probe(c)) return c;
	return null;
}

// Render-mode precedence: explicit config > kitty probe > symbols > text.
// probeResponse is the raw bytes the terminal answered to a kitty graphics
// query; empty/undefined means no answer (not supported). Kitty mode emits
// the PNG directly (f=100) and needs no chafa; symbols mode does.
export function pickRenderMode(
	env,
	configDirValue,
	probeResponse,
	chafaAvailable,
) {
	const explicit = env.HERDR_BROWSER_RENDER || configDirValue;
	if (explicit && ["kitty", "symbols", "text"].includes(explicit)) {
		return explicit === "symbols" && !chafaAvailable ? "text" : explicit;
	}
	if (probeResponse && probeResponse.includes("Gi=31;OK")) return "kitty";
	if (!chafaAvailable) return "text";
	return "symbols";
}

// Kitty graphics sequence for a PNG frame, transmitted as-is (f=100) in
// <=4KiB base64 chunks with m=1/m=0 continuations. The frame replaces the
// previous one in place (fixed image id) and is scaled by the terminal into
// a cell box that preserves pixel aspect with the same ~1:2 cell geometry
// chafa uses — so mapClickToPage math holds for both render modes.
export function kittyImageSequence(pngBuf, pngW, pngH, cols, imageRows) {
	const scale = Math.min(cols / pngW, (imageRows * 2) / pngH);
	if (!(scale > 0)) return "";
	const c = Math.max(1, Math.floor(pngW * scale));
	const r = Math.max(1, Math.floor((pngH * scale) / 2));
	const b64 = pngBuf.toString("base64");
	const CHUNK = 4096;
	const first = `a=T,f=100,i=${KITTY_IMAGE_ID},c=${c},r=${r},q=2`;
	let out = "";
	for (let off = 0; off < b64.length; off += CHUNK) {
		const part = b64.slice(off, off + CHUNK);
		const more = off + CHUNK < b64.length ? 1 : 0;
		out += `${ESC}_G${off === 0 ? `${first},` : ""}m=${more};${part}${ESC}\\`;
	}
	return out;
}

// Display-cell width: enough wcwidth for header truncation — CJK wide
// ranges and emoji count 2 cells, everything else 1.
function cellWidth(s) {
	let w = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		w +=
			cp >= 0x1100 &&
			(cp <= 0x115f ||
				cp === 0x2329 ||
				cp === 0x232a ||
				(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
				(cp >= 0xac00 && cp <= 0xd7a3) ||
				(cp >= 0xf900 && cp <= 0xfaff) ||
				(cp >= 0xfe30 && cp <= 0xfe6f) ||
				(cp >= 0xff00 && cp <= 0xff60) ||
				(cp >= 0xffe0 && cp <= 0xffe6) ||
				(cp >= 0x1f300 && cp <= 0x1faff) ||
				(cp >= 0x20000 && cp <= 0x3fffd))
				? 2
				: 1;
	}
	return w;
}

export function truncate(s, width) {
	if (width <= 0) return "";
	if (cellWidth(s) <= width) return s;
	let out = "";
	let w = 0;
	for (const ch of s) {
		const cw = cellWidth(ch);
		if (w + cw > width - 1) break;
		out += ch;
		w += cw;
	}
	return out + "…";
}

// Poll backoff: each tick spawns 4 agent-browser subprocesses, so a quiet
// page should not be polled at full rate forever. Any observed change (or
// user input) resets idleTicks to 0 and restores the base cadence. After
// ~5 quiet minutes the floor drops to 30x — an unwatched pane costs ~zero.
export function pollDelay(baseMs, idleTicks) {
	const mult =
		idleTicks < 10
			? 1
			: idleTicks < 30
				? 2
				: idleTicks < 60
					? 4
					: idleTicks < 300
						? 8
						: 30;
	// 2**31-1 is setTimeout's ceiling; beyond it Node fires after ~1ms.
	return Math.min(baseMs * mult, 2 ** 31 - 1);
}

// Page-controlled text (console lines, titles, URLs) gets written into the
// user's terminal; strip C0/C1 control chars so a page can't smuggle escape
// sequences (retitle, clear, OSC 52, kitty graphics) into the session.
export function sanitizeText(s) {
	return (
		String(s)
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) =>
				ch === "\t" ? " " : "",
			)
			// Bidi overrides and zero-width format chars survive C0/C1 stripping but
			// let page text visually spoof URLs in the header — drop them too.
			.replace(
				/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
				"",
			)
	);
}

// Full 8-byte PNG signature + IHDR, so a random file can't pass as a frame.
export function pngDims(buf) {
	if (
		buf.length < 24 ||
		buf.readUInt32BE(0) !== 0x89504e47 ||
		buf.readUInt32BE(4) !== 0x0d0a1a0a ||
		buf.readUInt32BE(12) !== 0x49484452
	)
		return null; // IHDR
	return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// A frame is only promoted to the live screenshot when it is a complete
// PNG: signature + IHDR + the terminal IEND chunk.
export function pngComplete(buf) {
	if (!pngDims(buf)) return false;
	return (
		buf.length >= 12 &&
		buf.readUInt32BE(buf.length - 12) === 0 && // IEND carries no data
		buf.readUInt32BE(buf.length - 8) === 0x49454e44
	); // 'IEND'
}

// JPEG dimensions from the start-of-frame marker (stream frames are JPEG).
export function jpegDims(buf) {
	if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null; // SOI
	let off = 2;
	while (off + 9 < buf.length) {
		if (buf[off] !== 0xff) return null;
		const marker = buf[off + 1];
		// Standalone markers without a length field: SOI, EOI, RSTn.
		if (
			marker === 0xd8 ||
			marker === 0xd9 ||
			(marker >= 0xd0 && marker <= 0xd7)
		) {
			off += 2;
			continue;
		}
		const len = buf.readUInt16BE(off + 2);
		if (len < 2) return null;
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker); // not DHT/JPG/DAC
		if (isSof)
			return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
		off += 2 + len;
	}
	return null;
}

export function imageDims(buf) {
	return pngDims(buf) || jpegDims(buf);
}

// SGR mouse report: ESC [ < button ; col ; row (M=press, m=release)
export function parseSgrMouse(s) {
	const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
	if (!m) return null;
	return {
		button: Number(m[1]),
		col: Number(m[2]),
		row: Number(m[3]),
		release: m[4] === "m",
	};
}

// Map a terminal cell click inside the image region to page pixel
// coordinates. chafa draws top-left into a cols x imageRows box preserving
// pixel aspect with a ~1:2 cell width:height ratio; work in half-cell units.
export function mapClickToPage(
	col,
	row,
	{ cols, imageRows, imageTopRow, pngW, pngH },
) {
	if (!pngW || !pngH || imageRows <= 0) return null;
	const unitX = col - 1 + 0.5;
	const unitY = (row - imageTopRow) * 2 + 1;
	if (unitY < 0) return null;
	const scale = Math.min(cols / pngW, (imageRows * 2) / pngH);
	if (!(scale > 0)) return null;
	if (unitX > pngW * scale || unitY > pngH * scale) return null;
	return { x: Math.round(unitX / scale), y: Math.round(unitY / scale) };
}

// Preserve the browser's current CSS-pixel width, but choose a height whose
// aspect ratio matches the terminal image box. Renderer geometry models one
// cell as ~1x2 pixel units (same assumption as chafa/mapClickToPage), so this
// removes vertical letterboxing without stretching or changing breakpoints.
export function viewportForPane(frameWidth, { cols, imageRows }) {
	const width = Math.round(Number(frameWidth));
	if (!(width > 0) || !(cols > 0) || imageRows < 3) return null;
	const w = Math.min(3840, Math.max(320, width));
	const h = Math.min(
		2160,
		Math.max(240, Math.round((w * imageRows * 2) / cols)),
	);
	return { w, h };
}

// Failed-request diffing over `network requests --json`. The daemon's log is
// append-only from the pane's perspective but can be wiped without notice
// (browser relaunch, external --clear), and pid.N-format requestIds can
// restart after a relaunch — so membership sets are pruned to the ids present
// in the current log every poll instead of trusting counts or id uniqueness.
// Seen-set membership means "already reported OR resolved to a non-failure
// status": an in-flight request must stay classifiable until its status
// lands, or a 500 arriving one poll late would be swallowed forever.
export function newNetworkState() {
	return {
		seen: new Set(), // requestIds reported or resolved 2xx/3xx
		recent: new Map(), // dedupe key -> last emit/suppress time (ms)
	};
}

export function diffNetworkFailures(state, entries, nowMs, opts = {}) {
	const ageThresholdMs = opts.ageThresholdMs ?? 15_000;
	const dedupeWindowMs = opts.dedupeWindowMs ?? 60_000;
	const maxPerPoll = opts.maxPerPoll ?? 5;
	const currentIds = new Set();
	const candidates = [];
	for (const e of entries) {
		const id = e?.requestId;
		if (typeof id !== "string" || !id) continue;
		currentIds.add(id);
		if (opts.baseline) {
			state.seen.add(id);
			continue;
		}
		if (state.seen.has(id)) continue;
		const status = typeof e.status === "number" ? e.status : null;
		if (status !== null) {
			state.seen.add(id);
			if (status >= 400 && status <= 599)
				candidates.push({ method: e.method ?? "GET", url: e.url ?? "", status });
			continue;
		}
		// Null status = still in flight OR failed at the connection level; the
		// daemon drops loadingFailed detail, so entry age past the threshold is
		// the only failure signal — and it must be entry age, not poll count:
		// pollDelay stretches ticks. Unaged ids stay out of `seen` so a status
		// arriving on a later poll is still classified.
		if (typeof e.timestamp === "number" && nowMs - e.timestamp > ageThresholdMs) {
			state.seen.add(id);
			candidates.push({
				method: e.method ?? "GET",
				url: e.url ?? "",
				status: null,
			});
		}
	}
	// Prune to the live log so wipes and id reuse stay harmless.
	for (const id of state.seen) if (!currentIds.has(id)) state.seen.delete(id);
	for (const [k, t] of state.recent)
		if (nowMs - t > dedupeWindowMs) state.recent.delete(k);
	// Chrome retries a failed navigation with fresh requestIds and app retry
	// loops mint new ids per attempt — dedupe by shape, refreshing the window
	// on suppressed hits so a steady loop paints once, not once per minute.
	const failures = [];
	let overflow = 0;
	for (const c of candidates) {
		const key = `${c.method} ${c.url} ${c.status ?? "no response"}`;
		const last = state.recent.get(key);
		state.recent.set(key, nowMs);
		if (last !== undefined && nowMs - last <= dedupeWindowMs) continue;
		if (failures.length < maxPerPoll) failures.push(c);
		else overflow++;
	}
	return { failures, overflow };
}

// Display text for one failure ("✖ " comes from pushConsole's error prefix).
// URLs are page-controlled and unbounded (data: URLs carry payloads) —
// sanitize and hard-cap before the line enters the 500-line store.
export function formatNetworkFailure({ method, url, status }) {
	const shownUrl = truncate(sanitizeText(url), 200);
	return `${status ?? "no response"} ${method} ${shownUrl}`;
}

// --- agent-browser access ---

export function makeBrowser(session, bin = "agent-browser") {
	// Console rings on noisy pages reach several MB — Node's 1 MiB default
	// maxBuffer would throw on every tick and freeze the pane for good.
	const maxBuffer = 16 * 1024 * 1024;
	// If a call is the one that spawns the session daemon, the daemon
	// self-reaps after idle instead of living forever. No-op for daemons an
	// agent already owns (read at daemon spawn only).
	const abEnv = () => ({
		...process.env,
		AGENT_BROWSER_IDLE_TIMEOUT_MS:
			process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || "1800000",
	});
	const parse = (stdout, what) => {
		let parsed;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(
				`agent-browser returned non-JSON ${what} (${stdout.length} bytes)`,
			);
		}
		return parsed;
	};
	// batch --json returns an array of {command, error, result, success};
	// --bail shortens the array after the first failure.
	const batch = async (cmds, timeout = 10_000) => {
		const { stdout } = await pExecFile(
			bin,
			["--session", session, "batch", "--bail", "--json", ...cmds],
			{ timeout, maxBuffer, env: abEnv() },
		);
		const arr = parse(stdout, "batch output");
		for (const r of arr) {
			if (r.success === false)
				throw new Error(r.error || "agent-browser error");
		}
		if (arr.length < cmds.length)
			throw new Error("agent-browser batch incomplete");
		return arr.map((r) => r.result);
	};
	const run = async (...args) => {
		const { stdout } = await pExecFile(
			bin,
			["--session", session, ...args, "--json"],
			{
				timeout: 10_000,
				maxBuffer,
				env: abEnv(),
			},
		);
		const parsed = parse(stdout, "output");
		if (parsed.success === false)
			throw new Error(parsed.error || "agent-browser error");
		return parsed.data;
	};
	return {
		// One subprocess per tick instead of four: url + title + console +
		// screenshot in a single batch call.
		snapshot: async (file) => {
			const [url, title, cons] = await batch(
				["get url", "get title", "console", `screenshot ${file}`],
				15_000,
			);
			return {
				url: url?.url ?? "",
				title: title?.title ?? "",
				entries: Array.isArray(cons) ? cons : (cons?.messages ?? []),
			};
		},
		// A real CDP mouse click at page pixel coordinates — what you click is
		// what Chrome clicks (overlays, canvas targets, shadow DOM included).
		click: async (x, y) => {
			await batch([`mouse move ${x} ${y}`, "mouse down", "mouse up"]);
		},
		open: async (u) => {
			await run("open", u);
		},
		back: async () => {
			await run("back");
		},
		forward: async () => {
			await run("forward");
		},
		reload: async () => {
			await run("reload");
		},
		scroll: async (dir, px) => {
			await run("scroll", dir, String(px));
		},
		// 'keyboard type' takes raw text; plain 'type' expects a selector first,
		// so the prompt's free-form input only works through the keyboard path.
		type: async (text) => {
			await run("keyboard", "type", text);
		},
		setViewport: async (w, h) => {
			await run("set", "viewport", String(w), String(h));
		},
		// Live push stream (agent-browser >= 0.23): 'already enabled' is not an
		// error for us, and status carries the WS port.
		streamEnable: async () => {
			try {
				await run("stream", "enable");
			} catch {
				/* already on */
			}
		},
		streamStatus: async () => run("stream", "status"),
		// Failed-request source (agent-browser >= 0.33). Read-only: never pass
		// --clear — external agents share the daemon's request log. --type
		// bounds payload (data: URLs and SSE/WS noise stay out) and is the
		// signal filter: failed xhr/fetch/document is what a dev wants to see.
		network: async () => {
			const data = await run(
				"network",
				"requests",
				"--type",
				"xhr,fetch,document",
			);
			if (Array.isArray(data?.requests)) return data.requests;
			return Array.isArray(data) ? data : [];
		},
		sessionExists: async () => {
			try {
				const { stdout } = await pExecFile(bin, ["session", "list", "--json"], {
					timeout: 10_000,
					maxBuffer,
				});
				// Exact match only: a substring hit (herdr-ws-w2 vs herdr-ws-w22)
				// would make the pane attach and auto-create a session it must not.
				const list = JSON.parse(stdout).data?.sessions ?? [];
				return list.some(
					(s) => (typeof s === "string" ? s : s?.name) === session,
				);
			} catch {
				return false;
			}
		},
	};
}

// --- renderer main ---

export class Renderer {
	constructor(env = process.env) {
		this.env = env;
		this.session = deriveSession(env, process.cwd());
		// HERDR_PLUGIN_STATE_DIR comes from the environment: expand a literal
		// leading '~' (nothing expands it inside a variable value) and refuse
		// relative paths — otherwise state silently lands in a per-cwd tree.
		let dir =
			env.HERDR_PLUGIN_STATE_DIR ||
			path.join(env.HOME || ".", ".local/state/herdr-browser");
		if (dir === "~" || dir.startsWith("~/"))
			dir = path.join(env.HOME || ".", dir.slice(1));
		if (!path.isAbsolute(dir))
			dir = path.join(env.HOME || ".", ".local/state/herdr-browser");
		this.stateDir = dir;
		fs.mkdirSync(this.stateDir, { recursive: true });
		fs.chmodSync(this.stateDir, 0o700);
		this.shot = path.join(
			this.stateDir,
			`shot-${safeWsId(env.HERDR_WORKSPACE_ID)}.png`,
		);
		this.bin = "agent-browser";
		// Backend arbitration: an explicitly configured CDP endpoint is the more
		// deliberate act than an ambient agent-browser session, so it wins — and
		// it wins deterministically at start, never by racing discovery.
		this.cdpEndpoint = this.resolveCdpEndpoint(env);
		// Backend (attach vs agent-browser) is not the render mode: run() assigns
		// this.mode from pickRenderMode (kitty/symbols/text) after the terminal
		// probe. Sharing one field made that assignment erase the attach decision,
		// so a configured endpoint never actually attached once run() started.
		this.backend = this.cdpEndpoint ? "attach" : "agent-browser";
		this.mode = null; // render mode; run() picks it after the kitty probe
		this.browser =
			this.backend === "attach"
				? makeCdpBrowser(this.cdpEndpoint)
				: makeBrowser(this.session, this.bin);
		// Attach mode observes a browser someone else owns: ownership is never
		// claimed, so the quit path can never close a stranger's session.
		this.ownershipEnabled = this.backend !== "attach";
		this.backendName = this.backend === "attach" ? "browser endpoint" : "agent-browser";
		const onPath = (cmd) =>
			spawnSync("sh", ["-c", `command -v ${cmd}`], { timeout: 5000 }).status ===
			0;
		this.agentBrowser = onPath(this.bin);
		this.chafa = onPath("chafa");
		// Clamp both ends: tiny/negative values busy-loop; values past the
		// setTimeout ceiling (2^31-1 after backoff) fire after ~1ms.
		this.intervalMs = Math.min(
			86_400_000,
			Math.max(250, Number(env.HERDR_BROWSER_INTERVAL_MS) || 1000),
		);
		this.idleTicks = 0;
		this.consolePushes = 0;
		this.lastHash = "";
		this.lastUrl = "";
		this.lastTitle = "";
		this.consoleState = { count: 0, tail: [] };
		this.consoleLines = [];
		this.failures = 0;
		this.banner = "";
		this.attached = false;
		this.selfCreated = false;
		// Observe-only: pane input (clicks, wheel, navigation, typing) is
		// dropped instead of forwarded, so watching a live automation run
		// cannot blur the field it is typing into or dismiss what it awaits.
		// Configurable at start for watch-the-agent workflows; o still toggles.
		// || not ??: a set-but-empty env var falls through to the config file,
		// matching resolveCdpEndpoint — the knob families must agree on what
		// an empty environment value means.
		this.observeOnly = truthyConfig(
			env.HERDR_BROWSER_OBSERVE || this.configValue("observe"),
		);
		// Launch-first workspaces: the first unattached tick launches a local
		// Chromium instead of waiting for an agent-browser session. One
		// attempt — a failed launch banners and leaves the keys in charge.
		this.launchConfigured =
			!this.cdpEndpoint &&
			truthyConfig(env.HERDR_BROWSER_LAUNCH || this.configValue("launch"));
		this.launchAttempted = false;
		this.promptState = null;
		this.paintQueue = Promise.resolve();
		this.paintErrors = 0;
		this.chafaFails = 0;
		this.chafaCooldownUntil = 0;
		this.stdoutBlocked = false;
		this.inputBuf = "";
		// Live push stream (see goLive): frames/console/tabs arrive by event.
		this.live = null;
		this.streamCooldownUntil = 0;
		this.suppressConsoleOnce = false;
		this.frameSeq = 0;
		this.shotFormat = "png";
		this.shotJpg = path.join(
			this.stateDir,
			`shot-${safeWsId(env.HERDR_WORKSPACE_ID)}.jpg`,
		);
		this.lastLiveCheck = 0;
		// Failed-request feed (see pollNetwork). The baseline flag makes the
		// first read after an attach swallow pre-attach history silently; the
		// off latch stops polling for the rest of the attach once the daemon's
		// unbounded log outgrows the exec limits — retrying a known-fatal
		// multi-MiB read every tick would waste CPU forever with no output.
		this.networkState = newNetworkState();
		this.networkBaselinePending = true;
		this.networkOff = false;
		this.networkPollBusy = false;
		this.networkPollErrors = 0;
		this.networkTimer = null; // live-mode cadence (see goLive/dropLive)
		this.networkIdleTicks = 0;
		// Attach mode (see attachCdp): endpoint identity, frame liveness, and
		// the per-frame metadata that scales pane clicks into page pixels.
		this.cdpGuid = null;
		this.cdpIdentity = null;
		this.lastFrameMeta = null;
		this.lastFrameAt = 0;
		this.staleHandled = false;
		this.loopbackWarned = false;
		// Launch mode (see launchChromium): the one browser the pane owns the
		// lifecycle of, because it spawned it. Quit must kill it — a leaked
		// headless Chrome has no other owner to collect it.
		this.launchedChild = null;
		this.launchedEndpoint = null;
		this.launchingChromium = false;
		// A click that arrived while the launch was still coming up parks its
		// URL here and is delivered on attach (see startNavigateWatch/attachCdp).
		this.pendingNavigateUrl = null;
		// A launch failure explains itself for this long before the generic
		// waiting-for-session banner may paint over it (see tick).
		this.bannerHoldUntil = 0;
		this.kittyAnon = false; // chafa emitted anonymous kitty placements
		this.lastImageDims = null;
		this.lastViewportRequest = "";
	}

	// Serialize all screen-writing work: ticks and resize redraws must never
	// interleave their stdout escape sequences. Failures are counted, not
	// silently swallowed forever — a persistent paint bug degrades the pane.
	enqueue(fn) {
		this.paintQueue = this.paintQueue.then(async () => {
			try {
				await fn();
			} catch {
				this.paintErrors++;
			}
		});
		return this.paintQueue;
	}

	size() {
		const cols = process.stdout.columns || 80;
		const rows = process.stdout.rows || 24;
		let consoleRows = 0;
		if (this.mode === "text") {
			consoleRows = Math.max(0, rows - 3);
		} else if (this.consoleLines.length > 0) {
			consoleRows = Math.max(4, Math.floor(rows * 0.3));
		}
		const imageRows =
			this.mode === "text" ? 0 : Math.max(0, rows - consoleRows - 4);
		return {
			cols,
			rows,
			imageRows,
			consoleRows,
			imageTopRow: 3,
			bottomRow: rows,
		};
	}

	async fitViewport(frameW, frameH) {
		if (typeof this.browser.setViewport !== "function") return false;
		this.lastImageDims = { w: frameW, h: frameH };
		const target = viewportForPane(frameW, this.size());
		if (!target) return false;
		const key = `${target.w}x${target.h}`;
		if (key === this.lastViewportRequest) return false;
		this.lastViewportRequest = key;
		if (Math.abs(frameH - target.h) <= 2) return false;
		try {
			await this.browser.setViewport(target.w, target.h);
			return true;
		} catch {
			this.lastViewportRequest = "";
			return false;
		}
	}

	// Shared failure-feed poll for both modes (tick calls it after a healthy
	// snapshot; the live-mode timer calls it directly). Returns true when it
	// painted failures, so the live timer can hold its base cadence on a page
	// whose only activity is failing requests. The in-flight guard prevents a
	// timer poll and a tick poll from racing the same state across the
	// dropLive transition. Never throws.
	async pollNetwork(baseline = false) {
		if (this.networkOff || this.networkPollBusy || !this.attached)
			return false;
		if (typeof this.browser.network !== "function") return false; // test doubles / older engines
		this.networkPollBusy = true;
		try {
			const entries = await this.browser.network();
			const { failures, overflow } = diffNetworkFailures(
				this.networkState,
				entries,
				Date.now(),
				{ baseline: baseline || this.networkBaselinePending },
			);
			this.networkBaselinePending = false;
			this.networkPollErrors = 0;
			if (!failures.length) return false;
			const hadConsole = this.consoleLines.length > 0;
			const lines = failures.map((f) => ({
				text: formatNetworkFailure(f),
				type: "error",
			}));
			if (overflow)
				lines.push({
					text: `…and ${overflow} more failed requests`,
					type: "error",
				});
			this.pushConsole(lines, false);
			this.queueConsolePaint(hadConsole);
			return true;
		} catch (err) {
			// The daemon log is unbounded and --clear is not ours to send: once
			// the payload exceeds maxBuffer or the exec timeout, every retry is
			// guaranteed to fail the same way. Latch off with one visible line.
			const fatal =
				/maxBuffer/i.test(err?.message ?? "") || err?.killed === true;
			if (fatal) {
				this.networkOff = true;
				const hadConsole = this.consoleLines.length > 0;
				this.pushConsole(
					[{ text: "network reporting off — request log too large", type: "error" }],
					false,
				);
				this.queueConsolePaint(hadConsole);
			} else {
				this.networkPollErrors++;
			}
			return false;
		} finally {
			this.networkPollBusy = false;
		}
	}

	// Endpoint sources, most deliberate first. Both are static (readable before
	// the renderer starts), which is what lets scripts/open.sh reach the same
	// verdict without a runtime marker file.
	resolveCdpEndpoint(env) {
		const raw = env.HERDR_BROWSER_CDP_URL || this.configValue("cdp-url");
		if (!raw) return null;
		const value = String(raw).trim();
		return value || null;
	}

	// Switch this pane to attach mode at runtime. Everything the old backend
	// reconciled against is meaningless afterwards, so state resets and the
	// console carries one discontinuity line.
	async attachTo(value, { note } = {}) {
		const endpoint = String(value ?? "").trim();
		if (!/^(wss?|https?):\/\//i.test(endpoint)) {
			this.banner =
				"not an endpoint — use http://host:port or ws://… (u navigates, a attaches)";
			this.header();
			return;
		}
		if (this.backend === "agent-browser" && this.live) this.dropLive();
		// Pointing the pane away from a browser it launched abandons it; kill
		// it now rather than leak a headless Chrome with no remaining owner.
		if (this.launchedChild && endpoint !== this.launchedEndpoint) {
			try {
				this.launchedChild.kill();
			} catch {
				/* already gone */
			}
			this.launchedChild = null;
			this.launchedEndpoint = null;
		}
		this.stopNetworkTimer();
		this.cdpEndpoint = endpoint;
		this.backend = "attach";
		this.ownershipEnabled = false;
		this.backendName = "browser endpoint";
		this.selfCreated = false; // never inherit ownership across a switch
		this.browser = makeCdpBrowser(endpoint);
		this.attached = false;
		// Static sources cannot see a runtime switch; the marker lets open.sh
		// route clicks to the handoff file while this pane is alive.
		try {
			fs.writeFileSync(
				path.join(this.stateDir, `backend-${safeWsId(this.env.HERDR_WORKSPACE_ID)}`),
				"attach\n",
				{ mode: 0o600 },
			);
		} catch {
			/* marker is best-effort; static workspaces never need it */
		}
		this.cdpGuid = null;
		this.resetBackendState();
		this.pushConsole(
			[{ text: note ?? "— switched to attach mode —", type: "log" }],
			false,
		);
		this.streamCooldownUntil = 0;
		await this.tick();
	}

	// Launch mode: start a local Chromium with a loopback DevTools port and
	// attach to it through the normal attach path. Unlike plain attach, the
	// pane owns this browser's lifecycle — it spawned it — so quit (or
	// attaching elsewhere) kills it instead of leaking a headless Chrome.
	// Port 0 + DevToolsActivePort avoids picking a port and racing for it:
	// Chrome binds an ephemeral port and writes it to the profile root.
	async launchChromium() {
		if (this.launchingChromium) return;
		if (this.launchedChild && this.launchedChild.exitCode === null) {
			// Still running (the pane may have attached elsewhere meanwhile in
			// a way that kept it): just point back at it.
			if (this.launchedEndpoint) this.userAction(() => this.attachTo(this.launchedEndpoint));
			return;
		}
		// Refuse before spawning: attaching to the result needs the Node 22
		// WebSocket client, and a browser we can never attach to would just
		// idle until quit.
		if (!cdpSupported()) {
			this.holdBanner("launch mode needs Node 22+ (global WebSocket) — pane is idle");
			return;
		}
		this.launchingChromium = true;
		try {
			// Probe with the renderer's own env so the pane and the launched
			// child resolve binaries from the same PATH.
			const bin = findChromium(this.env, this.configValue("chromium"), (c) =>
				spawnSync("sh", ["-c", 'command -v -- "$1"', "sh", c], {
					timeout: 5000,
					env: this.env,
				}).status === 0,
			);
			if (!bin) {
				this.holdBanner(
					"no Chromium found — set HERDR_BROWSER_CHROMIUM to a browser binary",
				);
				return;
			}
			const profile = path.join(
				this.stateDir,
				`chromium-profile-${safeWsId(this.env.HERDR_WORKSPACE_ID)}`,
			);
			// mkdir's mode applies only on creation (and umask can relax it);
			// the profile holds the launched browser's cookies and session
			// state, so tighten explicitly like the constructor does stateDir.
			fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
			fs.chmodSync(profile, 0o700);
			const portFile = path.join(profile, "DevToolsActivePort");
			try {
				fs.unlinkSync(portFile); // a stale port must never win the wait below
			} catch {
				/* none */
			}
			const headed = truthyConfig(this.env.HERDR_BROWSER_LAUNCH_HEADED);
			const args = [
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-background-networking",
				// Plain --headless: new headless on 112+, old headless before it
				// (both support DevTools and screencast); =new was removed in
				// newer Chromes and would eventually break launches.
				...(headed ? [] : ["--headless"]),
				// Chrome refuses to start as root without this; root (containers,
				// CI) already has no user boundary for the sandbox to defend.
				...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
				"about:blank",
			];
			this.banner = "launching Chromium…";
			this.header();
			let child;
			// spawn reports a missing or non-executable binary as an async
			// 'error' event, not a throw; without a listener that event is an
			// uncaughtException that takes the whole pane down.
			const spawnFailed = { err: null };
			try {
				child = spawn(bin, args, { stdio: "ignore" });
			} catch (err) {
				this.holdBanner(
					`cannot launch ${bin}: ${sanitizeText(err?.message ?? "spawn failed")}`,
				);
				return;
			}
			child.once("error", (err) => {
				spawnFailed.err = err;
			});
			const port = await this.waitForDevToolsPort(portFile, child, spawnFailed);
			if (!port) {
				try {
					child.kill();
				} catch {
					/* already dead */
				}
				this.holdBanner(
					spawnFailed.err
						? `cannot launch ${bin}: ${sanitizeText(spawnFailed.err.message ?? "spawn failed")}`
						: `${bin} did not expose a DevTools port — is it Chromium-based?`,
				);
				return;
			}
			this.launchedChild = child;
			this.launchedEndpoint = `http://127.0.0.1:${port}`;
			const ep = this.launchedEndpoint;
			child.once("exit", () => {
				if (this.launchedChild !== child) return;
				this.launchedChild = null;
				// A dead launched browser cannot be re-discovered — its port died
				// with it. Retrying would dial a corpse every cooldown; say what
				// actually helps instead. The launchedEndpoint comparison also
				// catches a crash before the queued attach ran (cdpEndpoint not
				// yet switched). Quit-path kills never get here: cleanup and
				// attach-elsewhere clear launchedChild before the event fires.
				if (this.cdpEndpoint === ep || this.launchedEndpoint === ep) {
					this.attached = false;
					this.streamCooldownUntil = Number.MAX_SAFE_INTEGER;
					this.holdBanner("launched Chromium exited — press l to relaunch");
				}
			});
			this.userAction(() => {
				// Died between the port read and this queued attach: dialing the
				// corpse would re-arm the retry loop the exit handler just
				// latched. Signal deaths leave exitCode null — check both.
				if (child.exitCode !== null || child.signalCode !== null) return;
				return this.attachTo(ep, { note: "— launched Chromium —" });
			});
		} catch (err) {
			// Callers fire-and-forget this promise; an uncaught throw here
			// (say, an unwritable profile dir) would surface as an unhandled
			// rejection and take the whole pane down instead of explaining.
			this.holdBanner(
				`launch failed: ${sanitizeText(err?.message ?? "unknown error")}`,
			);
		} finally {
			this.launchingChromium = false;
		}
	}

	// DevToolsActivePort appears in the profile root once the port is bound:
	// line 1 is the port, line 2 the browser target path (a capability token
	// we deliberately do not read — discovery re-derives it).
	async waitForDevToolsPort(portFile, child, spawnFailed = null, timeoutMs = 15_000) {
		const until = Date.now() + timeoutMs;
		while (Date.now() < until) {
			// Signal deaths leave exitCode null and set signalCode — check both.
			if (child.exitCode !== null || child.signalCode !== null) return null;
			if (spawnFailed?.err) return null; // binary missing/not executable
			try {
				const port = Number(
					fs.readFileSync(portFile, "utf8").split("\n")[0].trim(),
				);
				if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
			} catch {
				/* not written yet */
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		return null;
	}

	// Attach: connect, wire the event bridge, and take the R9 baseline. All
	// failures land in a banner — a bad endpoint must never crash the pane.
	async attachCdp() {
		if (!cdpSupported()) {
			this.banner =
				"attach mode needs Node 22+ (global WebSocket) — pane is idle";
			this.header();
			return false;
		}
		try {
			this.browser.onMessage((m) => this.onCdpMessage(m));
			const id = await this.browser.connect();
			// A reused port can front a different browser than last time; treat
			// that as a discontinuity rather than silently continuing the feed.
			if (this.cdpGuid && id.guid && id.guid !== this.cdpGuid) {
				this.resetBackendState();
				this.pushConsole(
					[{ text: "— reattached to a different browser —", type: "log" }],
					false,
				);
			}
			this.cdpGuid = id.guid;
			this.cdpIdentity = id;
			this.attached = true;
			this.startNavigateWatch();
			// A click while the launch was still coming up parked its URL here;
			// deliver it now that there is a browser, unless it has gone stale.
			const pending = this.pendingNavigateUrl;
			this.pendingNavigateUrl = null;
			if (pending && Date.now() - pending.at < 120_000) {
				this.userAction(() => this.browser.open(pending.url));
			}
			this.lastUrl = sanitizeText(id.url ?? "");
			this.lastTitle = sanitizeText(id.title ?? "");
			this.lastFrameAt = Date.now();
			// Endpoint URLs carry capability tokens in their path: host:port only.
			this.banner = id.rediscoverable
				? ""
				: `attached to ${redactWsUrl(this.cdpEndpoint)} (raw endpoint — no reconnect)`;
			if (!this.loopbackWarned && !/^(127\.|\[?::1\]?$|localhost)/.test(String(id.host))) {
				this.loopbackWarned = true;
				this.banner = `attached to ${id.host}:${id.port} — remote endpoint, traffic is unencrypted`;
			}
			this.header();
			return true;
		} catch (err) {
			this.attached = false;
			this.banner = `cannot attach to ${redactWsUrl(this.cdpEndpoint)}: ${sanitizeText(err?.message ?? "unknown error")}`;
			this.header();
			return false;
		}
	}

	// Cmd+click hand-off from open.sh. Watched rather than polled: the attach
	// tick backs off, and a click that navigates 30 s later reads as broken.
	// The tick-time read stays as the fallback for platforms where fs.watch
	// misses events (some network filesystems).
	startNavigateWatch() {
		if (
			(this.backend !== "attach" && !this.launchConfigured) ||
			this.navigateWatcher
		)
			return;
		this.navigateFile = path.join(
			this.stateDir,
			`navigate-${safeWsId(this.env.HERDR_WORKSPACE_ID)}`,
		);
		const consume = () => {
			let url;
			let age = 0;
			try {
				age = Date.now() - fs.statSync(this.navigateFile).mtimeMs;
				url = fs.readFileSync(this.navigateFile, "utf8").split("\n")[0].trim();
				fs.unlinkSync(this.navigateFile);
			} catch {
				return; // nothing pending
			}
			if (!url) return;
			// A handoff can predate this pane (written before it started, or
			// while its launch was broken); navigating to an hours-old click
			// out of nowhere is worse than dropping it.
			if (age > 300_000) return;
			// A Cmd+click handoff is page-affecting input like any other; the
			// URL is consumed (file already unlinked) but not forwarded.
			if (this.observeOnly) {
				this.noteObserveBlocked();
				return;
			}
			// Launch workspace with no browser up: the click is an explicit
			// ask — (re)launch and navigate once attached.
			if (!this.attached && this.launchConfigured) {
				this.pendingNavigateUrl = { url, at: Date.now() };
				this.launchAttempted = true;
				this.launchChromium();
				return;
			}
			this.userAction(() => this.browser.open(url));
		};
		this.consumeNavigateFile = consume;
		try {
			this.navigateWatcher = fs.watch(this.stateDir, (_e, name) => {
				if (name && name === path.basename(this.navigateFile)) consume();
			});
			this.navigateWatcher.unref?.();
		} catch {
			/* watch unsupported: the tick-time read still picks it up */
		}
		consume(); // a click may have landed before the pane started
	}

	resetBackendState() {
		this.consoleState = { count: 0, tail: [] };
		this.networkState = newNetworkState();
		this.lastHash = "";
		this.shotFormat = "png";
	}

	// Bridge: adapter messages arrive already shaped like stream messages, so
	// frames/url/page_error reuse onStreamMessage. Frames additionally carry
	// the integer ack id, acked once the paint enqueue settles.
	onCdpMessage(m) {
		if (m.type === "frame") {
			this.lastFrameAt = Date.now();
			this.lastFrameMeta = m.metadata ?? null;
			this.onStreamMessage({ type: "frame", data: m.data });
			// Ack after the paint queue drains. A skipped paint (blocked stdout,
			// chafa cooldown) still acks — a frozen stream is worse than a
			// dropped frame, and quality/max-dimension knobs bound the cost.
			this.enqueue(() => {}).then(() => this.browser.ackFrame?.(m.ackId, m.gen));
			return;
		}
		if (m.type === "url") {
			this.lastUrl = sanitizeText(m.url ?? "");
			if (m.title !== undefined) this.lastTitle = sanitizeText(m.title);
			this.enqueue(() => {
				this.header();
			});
			return;
		}
		if (m.type === "page_error" || m.type === "console") {
			this.onStreamMessage(m);
			return;
		}
		if (m.type === "log_entry") {
			this.pushLogEntry(m);
			return;
		}
		if (m.type === "target_gone") {
			this.banner = "the observed page closed — waiting";
			this.header();
			return;
		}
		if (m.type === "endpoint_gone") {
			this.attached = false;
			this.banner = "browser endpoint closed — waiting";
			this.header();
		}
	}

	// Log-domain entries. Network-source entries are the attach-mode
	// equivalent of the polling failure feed and share its dedupe window, so a
	// retry loop paints once in either mode; other sources (violation,
	// security, deprecation) paint at their own level.
	pushLogEntry(entry) {
		const text = entry.url
			? `${entry.text} ${truncate(sanitizeText(entry.url), 200)}`
			: entry.text;
		if (entry.source === "network") {
			const key = `log ${entry.url} ${entry.text}`;
			const now = Date.now();
			const last = this.networkState.recent.get(key);
			this.networkState.recent.set(key, now);
			if (last !== undefined && now - last <= 60_000) return;
		}
		const hadConsole = this.consoleLines.length > 0;
		this.pushConsole(
			[{ text, type: entry.level === "warning" ? "warn" : entry.level }],
			false,
		);
		this.queueConsolePaint(hadConsole);
	}

	// Pane cell -> frame pixel -> page CSS pixel. The frame is scaled by both
	// maxWidth and the observed browser's DPR, and either can change under us
	// (a human resizes the window mid-session), so the scale comes from the
	// latest frame's metadata every time — never cached.
	cdpPagePoint(framePt, frameDims) {
		const meta = this.lastFrameMeta;
		if (!meta || !frameDims?.w) return framePt;
		const sx = (meta.deviceWidth ?? frameDims.w) / frameDims.w;
		const sy = (meta.deviceHeight ?? frameDims.h) / frameDims.h;
		return { x: Math.round(framePt.x * sx), y: Math.round(framePt.y * sy) };
	}

	// Hidden tabs and DevTools screencast contention both present as a frozen
	// frame with no error. One restart attempt, last frame stays on screen.
	checkFrameStaleness(now = Date.now()) {
		if (this.backend !== "attach" || !this.attached || !this.lastFrameAt) return;
		if (now - this.lastFrameAt < 10_000 || this.staleHandled) return;
		this.staleHandled = true;
		this.banner = "frame stale (tab hidden or contended)";
		this.header();
		this.browser.restartScreencast?.().catch(() => {});
	}

	// Live mode has no snapshot tick and the push stream carries no network
	// events, so failures need their own low-cadence poll. pollDelay-style
	// backoff keeps an unwatched live pane near-free; the idle counter resets
	// on stream activity AND on painted failures — a background retry loop on
	// a visually static page produces neither frames nor console entries, so
	// the failures themselves must hold the base cadence.
	startNetworkTimer(baseMs = 4_000) {
		if (this.networkTimer || typeof this.browser.network !== "function")
			return;
		const fire = async () => {
			this.networkTimer = null;
			if (!this.live || !this.attached || this.networkOff) return;
			if (await this.pollNetwork()) this.networkIdleTicks = 0;
			else this.networkIdleTicks++;
			if (!this.live || this.networkOff) return; // dropped or latched mid-poll
			this.networkTimer = setTimeout(
				fire,
				pollDelay(baseMs, this.networkIdleTicks),
			);
			this.networkTimer.unref?.();
		};
		this.networkTimer = setTimeout(fire, baseMs);
		this.networkTimer.unref?.();
	}

	stopNetworkTimer() {
		if (this.networkTimer) {
			clearTimeout(this.networkTimer);
			this.networkTimer = null;
		}
	}

	queueConsolePaint(hadConsole) {
		const layoutChanged =
			this.mode !== "text" && !hadConsole && this.consoleLines.length > 0;
		return this.enqueue(async () => {
			if (!layoutChanged) {
				this.renderConsole();
				return;
			}
			await this.redrawAll();
			if (this.lastImageDims) {
				this.lastViewportRequest = "";
				await this.fitViewport(this.lastImageDims.w, this.lastImageDims.h);
			}
		});
	}

	configValue(name) {
		const dir = this.env.HERDR_PLUGIN_CONFIG_DIR;
		if (!dir) return undefined;
		const f = path.join(dir, name);
		try {
			return fs.readFileSync(f, "utf8").split("\n")[0].trim() || undefined;
		} catch {
			return undefined;
		}
	}

	header() {
		const { cols, rows } = this.size();
		if (rows < 6) {
			process.stdout.write(
				`${ESC}[1;1H${truncate(" terminal too small", cols)}${ESC}[K`,
			);
			this.lastHeaderSig = null; // force a repaint once we fit again
			return;
		}
		// Attach mode shows the endpoint (host:port only — the path is a
		// capability token); agent-browser mode shows the session name that
		// the quick-start instructions tell the user to copy from here.
		const source =
			this.backend === "attach"
				? `attach:${redactWsUrl(this.cdpEndpoint)}`
				: `session:${this.session}`;
		const observe = this.observeOnly ? "  observe-only" : "";
		const line1 = truncate(
			` herdr-browser  ${source}  mode:${this.mode ?? "-"}${observe}`,
			cols,
		);
		const blankHint =
			this.lastUrl === "about:blank" ? "  (nothing loaded yet)" : "";
		const line2 = this.banner
			? truncate(` ! ${this.banner}`, cols)
			: truncate(
					` ${this.lastUrl}${this.lastTitle ? "  —  " + this.lastTitle : ""}${blankHint}`,
					cols,
				);
		// Repaint-gating: the poll loop calls header() every tick; skip the
		// writes entirely when nothing visible changed.
		const headerSig = `${line1}\n${line2}\n${this.promptState ? `${this.promptState.label}${this.promptState.value}` : "-"}`;
		if (headerSig === this.lastHeaderSig) return;
		this.lastHeaderSig = headerSig;
		process.stdout.write(`${ESC}[1;1H${ESC}[7m${line1}${ESC}[K${ESC}[0m`);
		process.stdout.write(`${ESC}[2;1H${line2}${ESC}[K`);
		this.renderBottom();
	}

	renderBottom() {
		const { cols, bottomRow } = this.size();
		if (this.promptState) {
			const text = ` ${this.promptState.label}${this.promptState.value}█`;
			process.stdout.write(
				`${ESC}[${bottomRow};1H${truncate(text, cols)}${ESC}[K`,
			);
		} else {
			// Every advertised key is handled in both backends (a and l work
			// everywhere); t only moves targets on an attach backend.
			const help = this.observeOnly
				? " observe-only: input is not forwarded  o:enable-input  q:quit"
				: this.backend === "attach"
					? " u:url  a:attach  l:launch  i:type  b/f:hist  r:reload  j/k:scroll  t:target  o:observe  q:quit"
					: " u:url  a:attach  l:launch  i:type  b/f:hist  r:reload  j/k:scroll  o:observe  q:quit";
			process.stdout.write(
				`${ESC}[${bottomRow};1H${ESC}[2m${truncate(help, cols)}${ESC}[K${ESC}[0m`,
			);
		}
	}

	async renderImage() {
		const { cols, imageRows } = this.size();
		const shotPath = this.shotFormat === "jpg" ? this.shotJpg : this.shot;
		if (this.mode === "text" || imageRows < 3 || !fs.existsSync(shotPath))
			return;
		// Backpressure: a stalled consumer must not buffer whole frames per tick.
		if (this.stdoutBlocked) return;
		if (this.mode === "kitty" && this.shotFormat === "png") {
			// No chafa, no RGBA re-encode: the PNG goes to the terminal as-is
			// (typically 10-100x fewer bytes than chafa's kitty output).
			try {
				const buf = fs.readFileSync(shotPath);
				const dims = pngDims(buf);
				if (!dims) return;
				// A chafa-kitty frame (stream JPEG path) leaves anonymous
				// placements the id-targeted delete cannot reach: nuke once.
				const clear = this.kittyAnon ? KITTY_DELETE_ALL : "";
				this.kittyAnon = false;
				const flushed = process.stdout.write(
					`${clear}${ESC}[3;1H${kittyImageSequence(buf, dims.w, dims.h, cols, imageRows)}`,
				);
				if (!flushed && !this.stdoutBlocked) {
					this.stdoutBlocked = true;
					process.stdout.once("drain", () => {
						this.stdoutBlocked = false;
					});
				}
			} catch {
				/* shot vanished mid-read: next frame repaints */
			}
			return;
		}
		// chafa path: symbols mode always, kitty mode when the frame is a
		// stream JPEG (chafa decodes it; f=100 only accepts PNG).
		// Circuit breaker: a persistently hanging chafa would otherwise burn its
		// 15s timeout on every changed frame, freezing the pane's image forever.
		if (this.chafaFails >= 3 && Date.now() < this.chafaCooldownUntil) return;
		try {
			const { stdout } = await pExecFile(
				"chafa",
				[
					"-f",
					this.mode === "kitty" ? "kitty" : "symbols",
					"-s",
					`${cols}x${imageRows}`,
					"--animate",
					"off",
					"--probe",
					"off",
					"--polite",
					"on",
					"-c",
					"full",
					shotPath,
				],
				{ maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
			);
			this.chafaFails = 0;
			if (this.mode === "kitty") {
				// chafa's kitty output uses anonymous placements: clear both any
				// previous anonymous frame and our own id-addressed one.
				process.stdout.write(KITTY_DELETE_ALL);
				this.kittyAnon = true;
			} else {
				// chafa emits only the rows the scaled image needs; erase the rest
				// of the box or a shrinking frame leaves stale rows of the last one.
				for (let r = 3; r < 3 + imageRows; r++) {
					process.stdout.write(`${ESC}[${r};1H${ESC}[K`);
				}
			}
			process.stdout.write(`${ESC}[3;1H`);
			const flushed = process.stdout.write(stdout);
			if (!flushed && !this.stdoutBlocked) {
				this.stdoutBlocked = true;
				process.stdout.once("drain", () => {
					this.stdoutBlocked = false;
				});
			}
		} catch {
			this.chafaFails++;
			if (this.chafaFails >= 3) {
				this.chafaCooldownUntil = Date.now() + 60_000;
				this.banner = "image rendering paused: chafa not responding";
				this.header();
			}
		}
	}

	renderConsole() {
		const { cols, rows, consoleRows } = this.size();
		if (rows < 8 || consoleRows < 2) return; // below this, lines overpaint the header
		const top = rows - consoleRows;
		process.stdout.write(`${ESC}[${top};1H${"─".repeat(cols)}`);
		const lines = this.consoleLines.slice(-(consoleRows - 1));
		for (let i = 0; i < consoleRows - 1; i++) {
			const text = lines[i] ? truncate(lines[i], cols) : "";
			process.stdout.write(`${ESC}[${top + 1 + i};1H${text}${ESC}[K`);
		}
	}

	pushConsole(entries, marker) {
		this.consolePushes += entries.length + (marker ? 1 : 0);
		if (marker) this.consoleLines.push("— console cleared or rotated —");
		for (const e of entries) {
			const prefix =
				e.type === "error"
					? "✖ "
					: e.type === "warn" || e.type === "warning"
						? "⚠ "
						: "  ";
			// Sanitize the display copy only — reconcile matching needs raw texts.
			this.consoleLines.push(prefix + sanitizeText(e.text ?? ""));
		}
		if (this.consoleLines.length > 500) {
			this.consoleLines = this.consoleLines.slice(-500);
		}
	}

	async tick() {
		// Attach mode is event-driven: the tick only (re)connects, watches
		// liveness, and notices a stalled screencast. Frames and console
		// entries arrive over the CDP session, not from polling.
		if (this.backend === "attach") {
			if (!this.attached) {
				if (Date.now() < this.streamCooldownUntil) return;
				this.streamCooldownUntil = Date.now() + 5_000;
				await this.attachCdp();
				return;
			}
			if (Date.now() - this.lastLiveCheck > 15_000) {
				this.lastLiveCheck = Date.now();
				if (!(await this.browser.sessionExists())) {
					this.attached = false;
					// Re-discovery, not a re-dial: the browser may have restarted
					// and minted a fresh token, and a raw ws endpoint has none.
					this.banner = this.cdpIdentity?.rediscoverable
						? "browser endpoint went away — retrying"
						: `browser endpoint went away — restart the pane to reattach (${redactWsUrl(this.cdpEndpoint)})`;
					if (!this.cdpIdentity?.rediscoverable)
						this.streamCooldownUntil = Number.MAX_SAFE_INTEGER;
					this.header();
					return;
				}
			}
			this.checkFrameStaleness();
			this.consumeNavigateFile?.();
			return;
		}
		// Stay truly passive: any get/console/screenshot call would auto-create
		// the session (and a headless Chrome) on the daemon. Until the session
		// exists — created by an agent, a link click, or a URL-bearing open —
		// only run the non-creating existence check and wait.
		if (!this.attached) {
			// A launch-first workspace starts its own browser instead of
			// waiting. Once, from the tick so run()'s terminal setup is done;
			// on failure the banner stands and the keys are back in charge.
			if (this.launchConfigured && !this.launchAttempted) {
				this.launchAttempted = true;
				this.startNavigateWatch(); // clicks must work even mid-launch
				this.launchChromium();
				return;
			}
			// An in-flight launch (config or the l key) owns the banner; the
			// waiting-for-session advice below would overwrite it mid-wait.
			if (this.launchingChromium) return;
			if (!(await this.browser.sessionExists())) {
				// A held banner names a real failure (launch mode); repainting
				// generic waiting advice over it would erase the explanation.
				if (Date.now() < this.bannerHoldUntil) return;
				// A missing binary is not 'session not started yet' — the waiting
				// advice below can never fix it, so say what's actually wrong.
				// In a launch workspace the accurate advice is to retry the
				// launch — a click also retries it (see startNavigateWatch).
				this.banner = this.launchConfigured
					? "Chromium launch failed — press l or Cmd+click a localhost link to retry"
					: this.agentBrowser
						? `waiting for session "${this.session}" — Cmd+click a localhost link or have your agent use --session ${this.session}`
						: "agent-browser is not installed — press l to launch a local Chromium, or: npm install -g agent-browser";
				this.header();
				return;
			}
			this.attached = true;
			this.banner = "";
			this.streamCooldownUntil = 0; // try the live stream right away
			this.lastViewportRequest = ""; // fit the new session once
			// A (re-)attach may be a different session under the same name:
			// start the failure feed from a clean silent baseline every time.
			this.networkState = newNetworkState();
			this.networkBaselinePending = true;
			this.networkOff = false;
		}
		if (this.live) {
			// Event-driven: the stream paints everything; the poll loop only
			// confirms the session is still alive, at a fraction of the cadence.
			if (Date.now() - this.lastLiveCheck > 15_000) {
				this.lastLiveCheck = Date.now();
				if (!(await this.browser.sessionExists())) {
					this.dropLive();
					this.attached = false;
					this.selfCreated = false;
					this.banner = `session "${this.session}" ended — waiting for it to come back`;
					this.header();
				}
			}
			return;
		}
		// Go live once attached, then retry at most once a minute after failures.
		if (Date.now() >= this.streamCooldownUntil) {
			this.streamCooldownUntil = Date.now() + 60_000;
			if (await this.goLive()) {
				this.header(); // clear any waiting/failure banner on screen
				return;
			}
		}
		let failed = false;
		let consoleLayoutChanged = false;
		try {
			// Unique tmp name: a duplicate pane in this workspace must not be
			// able to rename (and corrupt) this renderer's in-flight frame.
			const tmp = `${this.shot}.${process.pid}.tmp`;
			const snap = await this.browser.snapshot(tmp);
			this.lastUrl = sanitizeText(snap.url);
			this.lastTitle = sanitizeText(snap.title);
			const { newEntries, marker } = reconcileConsole(
				this.consoleState,
				snap.entries,
			);
			if (this.suppressConsoleOnce) {
				this.suppressConsoleOnce = false;
			} else if (newEntries.length || marker) {
				const hadConsole = this.consoleLines.length > 0;
				this.pushConsole(newEntries, marker);
				consoleLayoutChanged =
					this.mode !== "text" && !hadConsole && this.consoleLines.length > 0;
				if (!consoleLayoutChanged) this.renderConsole();
			}
			this.consoleState = {
				count: snap.entries.length,
				tail: consoleTail(snap.entries),
			};

			const buf = fs.readFileSync(tmp);
			if (!pngComplete(buf)) throw new Error("incomplete screenshot frame");
			const dims = pngDims(buf);
			const hash = createHash("md5").update(buf).digest("hex");
			if (hash !== this.lastHash) {
				fs.renameSync(tmp, this.shot);
				fs.chmodSync(this.shot, 0o600);
				this.shotFormat = "png"; // heal after a dropped stream's jpg frames
				this.lastHash = hash;
				await this.renderImage();
				await this.fitViewport(dims.w, dims.h);
				if (consoleLayoutChanged) this.renderConsole();
			} else {
				fs.unlinkSync(tmp);
				if (consoleLayoutChanged) {
					await this.redrawAll();
					this.lastViewportRequest = "";
					await this.fitViewport(dims.w, dims.h);
				}
			}
			this.banner = "";
			this.failures = 0;
		} catch {
			failed = true;
			this.failures++;
		}
		// Best-effort by design: a broken failure feed must never take the
		// frame/console paint path down with it (pollNetwork never throws).
		if (!failed) await this.pollNetwork();
		if (failed && this.failures >= 3) {
			if (await this.browser.sessionExists()) {
				this.banner = "agent-browser not responding — retrying";
			} else {
				this.attached = false;
				// Ownership dies with the session that granted it: if someone later
				// recreates a session under the same name, it is not ours to close.
				this.selfCreated = false;
				this.failures = 0;
				this.banner = `session "${this.session}" ended — waiting for it to come back`;
			}
		}
		this.header();
	}

	// One permanent stdin pipeline: raw mode is set once and stdin is never
	// paused. During the startup probe, bytes route to the probe sink; after
	// that, to the interactive handler. (Toggling raw mode + pause/resume
	// around a temporary listener silently kills later delivery.)
	dbg(m) {
		if (this.env.HB_DEBUG_INPUT)
			fs.appendFileSync(this.env.HB_DEBUG_INPUT, m + "\n");
	}

	setupInput() {
		if (!process.stdin.isTTY) return;
		process.stdin.setRawMode(true);
		process.stdin.resume();
		// Streaming UTF-8 decode: escape sequences are pure ASCII (identical to
		// the old latin1 path) but typed text keeps its multibyte characters.
		const decoder = new TextDecoder("utf-8");
		process.stdin.on("data", (chunk) => {
			const s = decoder.decode(chunk, { stream: true });
			if (this.env.HB_DEBUG_INPUT) {
				fs.appendFileSync(
					this.env.HB_DEBUG_INPUT,
					`data sink=${!!this.probeSink} s=${JSON.stringify(s)}\n`,
				);
			}
			if (this.probeSink) this.probeSink(s);
			else this.feed(s);
		});
	}

	// DA1 response terminates the probe: every terminal answers ESC [ ? ... c
	probeKitty(timeoutMs = 300) {
		return new Promise((resolve) => {
			if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve("");
			let buf = "";
			const timer = setTimeout(() => {
				this.probeSink = null;
				resolve(buf);
			}, timeoutMs);
			this.probeSink = (s) => {
				buf += s;
				if (/\x1b\[\?[\d;]*c/.test(buf)) {
					clearTimeout(timer);
					this.probeSink = null;
					resolve(buf);
				}
			};
			process.stdout.write(
				`${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`,
			);
		});
	}

	// stdin arrives in arbitrary chunks: a mouse report can straddle two
	// reads and several keypresses can arrive coalesced. Buffer partial
	// escape tails and split everything into single events before dispatch.
	feed(s) {
		s = this.inputBuf + s;
		// Hold a trailing partial escape for the next chunk: ESC-[ alone, or
		// an incomplete mouse report. A bare ESC (prompt cancel) dispatches
		// immediately — holding it would swallow the cancel until another key.
		const tail = /\x1b\[(?:<[\d;]*)?$/.exec(s);
		this.inputBuf = tail ? tail[0] : "";
		s = s.slice(0, s.length - this.inputBuf.length);
		if (!s) return;
		if (this.promptState) {
			this.promptInput(s);
			return;
		}
		const mouseRe = /\x1b\[<\d+;\d+;\d+[Mm]/g;
		let m;
		let last = 0;
		const parts = [];
		const mice = [];
		while ((m = mouseRe.exec(s))) {
			parts.push(s.slice(last, m.index));
			mice.push(m[0]);
			last = m.index + m[0].length;
		}
		parts.push(s.slice(last));
		for (let i = 0; i < parts.length; i++) {
			for (const ch of parts[i]) this.onKey(ch);
			if (i < mice.length) this.onMouse(parseSgrMouse(mice[i]));
		}
	}

	onMouse(mouse) {
		if (!mouse || mouse.release) return;
		if (this.observeOnly && this.attached) {
			this.noteObserveBlocked();
			return;
		}
		// Wheel reports (64=up, 65=down) scroll the page; presses only.
		if (mouse.button === 64 || mouse.button === 65) {
			if (this.attached) {
				this.userAction(() =>
					this.browser.scroll(mouse.button === 64 ? "up" : "down", 300),
				);
			}
			return;
		}
		if (mouse.button !== 0 || !this.attached) return;
		this.userAction(() => this.clickAt(mouse.col, mouse.row));
	}

	// A banner that names a real failure must outlive the next poll tick, or
	// the generic waiting-for-session advice paints over it within a second.
	holdBanner(text, ms = 30_000) {
		this.banner = text;
		this.bannerHoldUntil = Date.now() + ms;
		this.header();
	}

	// Observe-only is a pane-side latch, deliberately not a backend call:
	// nothing about the observed browser changes, input simply stops here.
	toggleObserveOnly() {
		this.observeOnly = !this.observeOnly;
		if (!this.observeOnly && this.banner.startsWith("observe-only"))
			this.banner = "";
		this.lastHeaderSig = null; // the observe marker lives in line 1
		this.header();
		this.renderBottom();
	}

	noteObserveBlocked() {
		if (this.banner.startsWith("observe-only")) return;
		this.banner = "observe-only — input is not forwarded (o re-enables)";
		this.header();
	}

	onKey(ch) {
		// A prompt owns the keyboard; clicks while typing must not drive the
		// page behind the prompt.
		if (this.promptState) {
			this.promptInput(ch);
			return;
		}
		// The toggle itself must stay reachable while observe-only is on.
		if (ch === "o") {
			this.toggleObserveOnly();
			return;
		}
		if (
			this.observeOnly &&
			["u", "i", "b", "f", "r", "j", "k", " "].includes(ch)
		) {
			this.noteObserveBlocked();
			return;
		}
		// a and l must stay reachable while unattached — no session yet and a
		// dead endpoint are exactly when attaching or launching is the answer.
		if (!this.attached && !["u", "a", "l", "q", "\x03"].includes(ch)) return;
		switch (ch) {
			case "u":
				this.openPrompt("URL: ", (v) => this.navigate(v));
				break;
			// Attach gets its own key: "localhost:9222" is already a valid
			// navigation target, so overloading the URL prompt would force a
			// heuristic that guesses wrong on exactly the common case.
			case "a":
				this.openPrompt("attach to endpoint: ", (v) => this.attachTo(v));
				break;
			// Deliberately unqueued: the DevTools-port wait can take seconds and
			// must not stall the paint queue; only the final attach is enqueued.
			case "l":
				this.launchChromium();
				break;
			// Cycle the pinned page target (attach mode, R6). View-only motion:
			// it moves the pane's screencast, never focus or page state, so it
			// stays allowed under observe-only.
			case "t":
				if (this.backend !== "attach") break;
				this.userAction(async () => {
					const moved = await this.browser.cycleTarget?.();
					if (!moved) {
						this.banner = "no other page targets";
						this.header();
					} else if (this.banner === "no other page targets") {
						this.banner = "";
						this.header();
					}
				});
				break;
			case "i":
				this.openPrompt("type: ", (v) => this.browser.type(v));
				break;
			case "b":
				this.userAction(() => this.browser.back());
				break;
			case "f":
				this.userAction(() => this.browser.forward());
				break;
			case "r":
				this.userAction(() => this.browser.reload());
				break;
			case "j":
			case " ":
				this.userAction(() => this.browser.scroll("down", 300));
				break;
			case "k":
				this.userAction(() => this.browser.scroll("up", 300));
				break;
			case "q":
			case "\x03":
				this.cleanup();
				process.exit(0);
		}
	}

	openPrompt(label, onSubmit) {
		this.promptState = { label, value: "", onSubmit };
		this.renderBottom();
	}

	promptInput(s) {
		const p = this.promptState;
		// Swallow mouse reports whole: a click while typing must neither cancel
		// the prompt (the report starts with ESC) nor leak into the value.
		s = s.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
		for (const ch of s) {
			if (ch === "\r" || ch === "\n") {
				this.promptState = null;
				this.renderBottom();
				const v = p.value.trim();
				if (v) this.userAction(() => p.onSubmit(v));
				return;
			}
			if (ch === "\x1b") {
				this.promptState = null;
				this.renderBottom();
				return;
			}
			if (ch === "\x7f" || ch === "\b") p.value = p.value.slice(0, -1);
			// Printable chars only; 8-bit C1 controls (0x80-0x9f) are refused —
			// the value is echoed to the terminal on every keystroke.
			else if (ch >= " " && !(ch >= "\x7f" && ch <= "\x9f")) p.value += ch;
		}
		this.renderBottom();
	}

	// Everything the poll loop watches, cheap to compare between ticks.
	// consolePushes is monotonic so console traffic still registers once
	// consoleLines has hit its 500-line display cap.
	sig() {
		return [
			this.attached,
			this.banner,
			this.lastUrl,
			this.lastTitle,
			this.lastHash,
			this.consolePushes,
			this.frameSeq,
		].join("\0");
	}

	// --- live stream (push) ---
	// agent-browser >= 0.23 runs a per-session WebSocket that pushes screencast
	// frames (JPEG, pushed on change), console entries, page errors, and tab
	// state. When it connects, the pane is event-driven and the poll loop only
	// watches the session's liveness. Every failure falls back to polling.
	async goLive() {
		if (typeof WebSocket !== "function") return false; // Node < 22: poll
		if (typeof this.browser.streamEnable !== "function") return false; // test doubles
		// Stream frames are JPEG and kitty's f=100 only accepts PNG: without
		// chafa to decode them, poll mode (direct PNG) is strictly better.
		if (this.mode === "kitty" && !this.chafa) return false;
		await this.browser.streamEnable();
		let status;
		try {
			status = await this.browser.streamStatus();
		} catch {
			status = null;
		}
		// The port comes from a CLI response — validate before building a URL.
		const port = Number(status?.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
		let ws;
		try {
			ws = new WebSocket(`ws://127.0.0.1:${port}`);
		} catch {
			return false; // malformed URL or constructor failure: just poll
		}
		const ok = await new Promise((resolve) => {
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch {
					/* fine */
				}
				resolve(false);
			}, 3000);
			ws.onopen = () => {
				clearTimeout(timer);
				resolve(true);
			};
			ws.onerror = () => {
				clearTimeout(timer);
				resolve(false);
			};
		});
		if (!ok) return false;
		this.live = { ws };
		ws.onmessage = (ev) => {
			let m;
			try {
				m = JSON.parse(ev.data);
			} catch {
				return;
			}
			// A malformed message must never become an uncaughtException —
			// those bypass cleanup() and leave the terminal wedged.
			try {
				this.onStreamMessage(m);
			} catch {
				this.paintErrors++;
			}
		};
		const drop = () => this.dropLive("live stream dropped — polling");
		ws.onclose = drop;
		ws.onerror = drop;
		this.banner = "";
		this.networkIdleTicks = 0;
		this.startNetworkTimer();
		return true;
	}

	dropLive(note) {
		// First: a timer poll must not fire into the poll-mode transition and
		// race tick's poll over the same diff state.
		this.stopNetworkTimer();
		const wasLive = !!this.live;
		if (this.live) {
			try {
				this.live.ws.close();
			} catch {
				/* already closed */
			}
			this.live = null;
		}
		this.streamCooldownUntil = Date.now() + 60_000;
		// The poll path re-syncs the console ring silently once, so entries the
		// stream already showed are not replayed as a wall of "new" lines.
		this.suppressConsoleOnce = true;
		// The next rendered/read frame must be the poll path's fresh PNG, not
		// the stream's now-frozen last JPEG.
		this.shotFormat = "png";
		if (note && wasLive) {
			this.banner = note;
			this.header();
		}
	}

	onStreamMessage(m) {
		switch (m.type) {
			case "frame": {
				if (typeof m.data !== "string") return;
				const buf = Buffer.from(m.data, "base64");
				const dims = jpegDims(buf);
				if (!dims) return;
				const tmp = `${this.shotJpg}.${process.pid}.tmp`;
				try {
					fs.writeFileSync(tmp, buf);
					fs.renameSync(tmp, this.shotJpg);
					fs.chmodSync(this.shotJpg, 0o600);
				} catch {
					return;
				}
				this.shotFormat = "jpg";
				this.frameSeq++;
				this.networkIdleTicks = 0; // page activity: keep failure polls prompt
				this.enqueue(async () => {
					await this.renderImage();
					await this.fitViewport(dims.w, dims.h);
				});
				break;
			}
			case "console": {
				this.networkIdleTicks = 0; // page activity: keep failure polls prompt
				const hadConsole = this.consoleLines.length > 0;
				this.pushConsole(
					[{ text: m.text ?? "", type: m.level ?? "log" }],
					false,
				);
				this.queueConsolePaint(hadConsole);
				break;
			}
			case "page_error": {
				const hadConsole = this.consoleLines.length > 0;
				this.pushConsole(
					[
						{
							text: m.text ?? m.error ?? m.message ?? "page error",
							type: "error",
						},
					],
					false,
				);
				this.queueConsolePaint(hadConsole);
				break;
			}
			case "tabs": {
				if (!Array.isArray(m.tabs)) break;
				const active = m.tabs.find((t) => t.active);
				if (active) {
					this.lastUrl = sanitizeText(active.url ?? "");
					this.lastTitle = sanitizeText(active.title ?? "");
					this.enqueue(() => {
						this.header();
					});
				}
				break;
			}
			case "url":
				this.lastUrl = sanitizeText(m.url ?? "");
				this.enqueue(() => {
					this.header();
				});
				break;
			default: // status, command, result: nothing to paint
		}
	}

	// User-initiated drive of the shared session: run the action, then refresh
	// immediately instead of waiting for the next poll tick.
	userAction(fn) {
		this.idleTicks = 0; // interaction restores the base poll cadence
		this.enqueue(async () => {
			try {
				await fn();
			} catch {
				// Poll mode reports daemon failures via the tick failure counter;
				// live mode's tick never runs that path, so say it directly.
				this.banner = `command failed — ${this.backendName} not responding`;
				this.header();
			}
		}).then(() => this.enqueue(() => this.tick()));
	}

	async navigate(v) {
		// Same policy as the launchers' validate_url: plain http(s) only (any
		// case), no credentials in the authority — and tell the user why nothing
		// happened instead of failing silently. An explicit non-http scheme://
		// must be refused before prefixing — "https://file:///x" parses as a
		// valid https URL with host "file". Bare host:port (localhost:3000)
		// stays allowed. Scheme-less junk containing '@' (mailto:user@x.com)
		// prefixes into a valid https URL with a userinfo authority — refuse.
		const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
		const u = /^https?:\/\//i.test(v) ? v : `https://${v}`;
		let parsed;
		try {
			parsed = new URL(u);
		} catch {
			parsed = null;
		}
		if (
			(explicitScheme && !/^https?:\/\//i.test(v)) ||
			v.startsWith("-") ||
			!parsed ||
			!["http:", "https:"].includes(parsed.protocol) ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password
		) {
			this.banner = `not an http(s) URL: ${truncate(sanitizeText(v), 48)}`;
			this.header();
			return;
		}
		// If this navigation is what brings the session to life, the pane owns
		// it and closes it on quit. A session an agent created is never ours —
		// and ownership is claimed only after the open actually succeeds, so a
		// failed navigate can never make us kill someone else's session.
		const existed = await this.browser.sessionExists();
		// Failure-feed baseline splits on the same check: an existing session
		// gets a real silent-baseline read before open (so only the navigation's
		// own failures paint), while a not-yet-existing session gets state-only
		// seeding — a pre-open network read would auto-create the session and
		// break the ownership rule below. Fresh daemons arm request tracking at
		// spawn, so the navigation's failures are in the log for the first
		// post-attach poll either way.
		this.networkState = newNetworkState();
		this.networkOff = false;
		if (existed) {
			// Stays pending until a read actually completes: if a live-timer
			// poll is in flight, the busy guard skips this read, and clearing
			// the flag here would let the next poll replay the whole log.
			this.networkBaselinePending = true;
			this.attached = true; // pollNetwork requires it; the session exists
			await this.pollNetwork(true);
		} else {
			this.networkBaselinePending = false; // nothing to swallow: empty log
		}
		await this.browser.open(u);
		if (!existed && this.ownershipEnabled) this.selfCreated = true;
		this.attached = true; // the user is explicitly starting/driving the session
	}

	async clickAt(col, row) {
		const { cols, imageRows, imageTopRow } = this.size();
		if (row < imageTopRow || row >= imageTopRow + imageRows) return;
		const shotPath = this.shotFormat === "jpg" ? this.shotJpg : this.shot;
		let dims;
		try {
			dims = imageDims(fs.readFileSync(shotPath));
		} catch {
			return;
		}
		if (!dims) return;
		const pt = mapClickToPage(col, row, {
			cols,
			imageRows,
			imageTopRow,
			pngW: dims.w,
			pngH: dims.h,
		});
		if (!pt) return;
		// Attach-mode frames are scaled by maxWidth and the observed browser's
		// DPR, so frame pixels are not page pixels — rescale before dispatch.
		const target = this.backend === "attach" ? this.cdpPagePoint(pt, dims) : pt;
		await this.browser.click(target.x, target.y);
	}

	async redrawAll() {
		process.stdout.write(`${ESC}[2J`);
		if (this.mode === "kitty") process.stdout.write(KITTY_DELETE_ALL);
		this.lastHeaderSig = null; // screen was cleared: header must repaint
		this.header();
		await this.renderImage();
		this.renderConsole();
	}

	cleanup() {
		if (this.mode === "kitty") process.stdout.write(KITTY_DELETE_ALL);
		this.stopNetworkTimer();
		try {
			this.live?.ws.close();
		} catch {
			/* already closed */
		}
		this.live = null;
		// The runtime-backend marker routes clicks only while this pane lives.
		try {
			fs.unlinkSync(
				path.join(this.stateDir, `backend-${safeWsId(this.env.HERDR_WORKSPACE_ID)}`),
			);
		} catch {
			/* never written */
		}
		if (this.launchedChild) {
			// The pane spawned this browser; quitting must not leak it. SIGTERM
			// lets Chrome flush its profile — its own exit handles the rest.
			try {
				this.launchedChild.kill();
			} catch {
				/* already gone */
			}
			this.launchedChild = null;
		}
		if (this.backend === "attach") {
			// Stop our screencast and drop the socket. Never a target close,
			// never an agent-browser subprocess — we did not create any of this.
			try {
				this.browser.close?.();
			} catch {
				/* endpoint already gone */
			}
		}
		if (this.selfCreated && this.ownershipEnabled) {
			// The session exists only because the user navigated in this pane;
			// quitting the pane ends it (and its daemon) instead of leaking it.
			// Short timeout: a wedged daemon must not freeze the quit path — its
			// own idle reaper collects the session anyway.
			try {
				spawnSync(this.bin, ["--session", this.session, "close"], {
					timeout: 2_000,
				});
			} catch {
				/* already gone */
			}
		}
		for (const f of [
			this.shot,
			this.shot + ".tmp",
			`${this.shot}.${process.pid}.tmp`,
			this.shotJpg,
			`${this.shotJpg}.${process.pid}.tmp`,
		]) {
			try {
				fs.unlinkSync(f);
			} catch {
				/* already gone */
			}
		}
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* fine */
		}
		process.stdout.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[?1049l${ESC}[?25h`);
	}

	async run() {
		this.setupInput();
		// Register exits before anything that can hang (kitty probe, first
		// paint) so a kill in that window still restores the terminal.
		for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
			process.on(sig, () => {
				this.cleanup();
				process.exit(0);
			});
		}
		// Last-resort safety net: a throw outside the run() promise (event
		// handlers, timers) must still restore the terminal on the way out.
		process.on("uncaughtException", (err) => {
			this.cleanup();
			console.error("herdr-browser renderer crashed:", err.message);
			process.exit(1);
		});
		const probe = await this.probeKitty();
		this.mode = pickRenderMode(
			this.env,
			this.configValue("render"),
			probe,
			this.chafa,
		);
		process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
		if (this.mode === "text") {
			this.consoleLines.push(
				this.chafa
					? "text mode (set render config to kitty/symbols for screenshots)"
					: "chafa not found — text-only mode. Install: brew install chafa",
			);
		}
		await this.redrawAll();
		process.stdout.write(`${ESC}[?1000h${ESC}[?1006h`);

		let resizeTimer = null;
		process.stdout.on("resize", () => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(
				() =>
					this.enqueue(async () => {
						this.lastViewportRequest = "";
						if (this.lastImageDims) {
							await this.fitViewport(
								this.lastImageDims.w,
								this.lastImageDims.h,
							);
						}
						await this.redrawAll();
					}),
				150,
			);
		});

		while (true) {
			const before = this.sig();
			await this.enqueue(() => this.tick());
			this.idleTicks = this.sig() === before ? this.idleTicks + 1 : 0;
			await new Promise((r) =>
				setTimeout(r, pollDelay(this.intervalMs, this.idleTicks)),
			);
		}
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	// Construct inside the async wrapper so constructor failures (state-dir
	// permissions, etc.) hit the same catch and never flash-close the pane.
	(async () => {
		await new Renderer().run();
	})().catch((err) => {
		// Restore everything the interactive path enables — a pane left in raw
		// mode (or with mouse reporting on) swallows keystrokes for the whole
		// 10-minute linger below.
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* never set */
		}
		process.stdout.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[?1049l${ESC}[?25h`);
		console.error("herdr-browser renderer crashed:", err.message);
		setTimeout(() => process.exit(1), 600_000);
	});
}
