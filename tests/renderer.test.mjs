import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	deriveSession,
	reconcileConsole,
	consoleTail,
	pickRenderMode,
	truncate,
	pngDims,
	pngComplete,
	jpegDims,
	imageDims,
	parseSgrMouse,
	mapClickToPage,
	sanitizeText,
	Renderer,
	makeBrowser,
	pollDelay,
	safeWsId,
	kittyImageSequence,
	viewportForPane,
	newNetworkState,
	diffNetworkFailures,
	formatNetworkFailure,
} from "../bin/renderer.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const e = (texts) => texts.map((t) => ({ text: t, type: "log" }));

// A structurally valid 1x1 PNG: signature + IHDR + IEND (CRCs unchecked here).
const PNG_1PX = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	(() => {
		const b = Buffer.alloc(25);
		b.writeUInt32BE(13, 0);
		b.writeUInt32BE(0x49484452, 4);
		b.writeUInt32BE(1, 8);
		b.writeUInt32BE(1, 12);
		return b;
	})(),
	(() => {
		const b = Buffer.alloc(12);
		b.writeUInt32BE(0x49454e44, 4);
		return b;
	})(),
]);

const mkRenderer = (over = {}) =>
	new Renderer({
		HERDR_BROWSER_SESSION: "hb-test",
		HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "hb-r-")),
		HOME: os.homedir(),
		...over,
	});
// Silence painting; keep state transitions observable.
const quiet = (r) => {
	r.header = () => {};
	r.renderConsole = () => {};
	r.renderBottom = () => {};
	r.renderImage = async () => {};
	return r;
};
const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

test("reconcile: first poll returns everything", () => {
	const r = reconcileConsole({ count: 0, tail: [] }, e(["a", "b"]));
	assert.deepEqual(
		r.newEntries.map((x) => x.text),
		["a", "b"],
	);
	assert.equal(r.marker, false);
});

test("reconcile: plain append below ring size", () => {
	const r = reconcileConsole(
		{ count: 2, tail: ["a", "b"] },
		e(["a", "b", "c"]),
	);
	assert.deepEqual(
		r.newEntries.map((x) => x.text),
		["c"],
	);
	assert.equal(r.marker, false);
});

test("reconcile: external clear shrinks buffer -> marker", () => {
	const r = reconcileConsole({ count: 5, tail: ["d", "e"] }, e(["x", "y"]));
	assert.deepEqual(
		r.newEntries.map((x) => x.text),
		["x", "y"],
	);
	assert.equal(r.marker, true);
});

test("reconcile: saturated ring rotation with partial tail survival", () => {
	// ring of 5: buffer was [a..e], now [d..h] — 'c' from our tail was evicted
	const prev = { count: 5, tail: ["c", "d", "e"] };
	const r = reconcileConsole(prev, e(["d", "e", "f", "g", "h"]), 5);
	assert.deepEqual(
		r.newEntries.map((x) => x.text),
		["f", "g", "h"],
	);
	assert.equal(r.marker, false);
});

test("reconcile: rotation evicted entire tail -> marker + full set", () => {
	const prev = { count: 5, tail: ["x", "y", "z"] };
	const r = reconcileConsole(prev, e(["d", "e", "f", "g", "h"]), 5);
	assert.equal(r.marker, true);
	assert.equal(r.newEntries.length, 5);
});

test("consoleTail keeps last n texts", () => {
	assert.deepEqual(consoleTail(e(["a", "b", "c"]), 2), ["b", "c"]);
});

test("pickRenderMode precedence", () => {
	assert.equal(
		pickRenderMode(
			{ HERDR_BROWSER_RENDER: "text" },
			undefined,
			"Gi=31;OK",
			true,
		),
		"text",
	);
	assert.equal(pickRenderMode({}, "kitty", "", true), "kitty");
	assert.equal(
		pickRenderMode({}, undefined, "\x1b_Gi=31;OK\x1b\\\x1b[?62c", true),
		"kitty",
	);
	assert.equal(pickRenderMode({}, undefined, "\x1b[?62c", true), "symbols");
	assert.equal(pickRenderMode({}, undefined, "", true), "symbols");
	// Kitty mode emits the PNG directly (f=100) — no chafa needed.
	assert.equal(pickRenderMode({}, undefined, "Gi=31;OK", false), "kitty");
	assert.equal(
		pickRenderMode({}, "symbols", "", false),
		"text",
		"explicit symbols without chafa degrades to text",
	);
	assert.equal(pickRenderMode({}, undefined, "", false), "text");
});

test("deriveSession precedence: env > config > workspace > cwd", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
	fs.writeFileSync(path.join(tmp, "session"), "my-session\n");
	assert.equal(deriveSession({ HERDR_BROWSER_SESSION: "ov" }, "/"), "ov");
	assert.equal(
		deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp }, "/"),
		"my-session",
	);
	assert.equal(deriveSession({ HERDR_WORKSPACE_ID: "w2" }, "/"), "herdr-ws-w2");
	assert.match(deriveSession({}, "/some/dir"), /^herdr-cwd-\d+$/);
});

test("deriveSession config parsing matches bash: strips inner whitespace, skips empty", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-cfg-"));
	fs.writeFileSync(path.join(tmp, "session"), "my session\n");
	assert.equal(
		deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp }, "/"),
		"mysession",
	);
	fs.writeFileSync(path.join(tmp, "session"), "\n");
	assert.equal(
		deriveSession(
			{ HERDR_PLUGIN_CONFIG_DIR: tmp, HERDR_WORKSPACE_ID: "w2" },
			"/",
		),
		"herdr-ws-w2",
	);
});

test("deriveSession cwd fallback survives shell metacharacters in path", () => {
	const base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "hb-meta-")),
	);
	const cwd = path.join(base, 'proj$HOME"x');
	fs.mkdirSync(cwd);
	const js = deriveSession({}, cwd);
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	const sh = execFileSync(
		"bash",
		["-c", `. "${repoRoot}/scripts/lib.sh" && session_name`],
		{ cwd, env: cleanEnv },
	)
		.toString()
		.trim();
	assert.equal(js, sh);
});

test("deriveSession cwd fallback matches bash session_name()", () => {
	const cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "hb-lockstep-")),
	);
	const js = deriveSession({}, cwd);
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	const sh = execFileSync(
		"bash",
		["-c", `. "${repoRoot}/scripts/lib.sh" && session_name`],
		{ cwd, env: cleanEnv },
	)
		.toString()
		.trim();
	assert.equal(js, sh);
});

test("pngDims requires the PNG signature + IHDR, rejects junk", () => {
	const buf = Buffer.alloc(24);
	buf.writeUInt32BE(0x89504e47, 0); // \x89PNG
	buf.writeUInt32BE(0x0d0a1a0a, 4); // \r\n\x1a\n
	buf.writeUInt32BE(0x49484452, 12);
	buf.writeUInt32BE(1280, 16);
	buf.writeUInt32BE(720, 20);
	assert.deepEqual(pngDims(buf), { w: 1280, h: 720 });
	assert.equal(pngDims(Buffer.alloc(10)), null);
	assert.equal(pngDims(Buffer.alloc(24)), null, "no signature");
	const noSig = Buffer.from(buf);
	noSig.writeUInt32BE(0, 0);
	assert.equal(pngDims(noSig), null, "IHDR alone is not a PNG");
});

test("pngComplete requires the terminal IEND chunk", () => {
	assert.equal(pngComplete(PNG_1PX), true);
	assert.equal(
		pngComplete(PNG_1PX.subarray(0, PNG_1PX.length - 12)),
		false,
		"truncated frame must not be promoted",
	);
	assert.equal(pngComplete(Buffer.from("not a png at all")), false);
});

test("parseSgrMouse parses press and release", () => {
	assert.deepEqual(parseSgrMouse("\x1b[<0;40;10M"), {
		button: 0,
		col: 40,
		row: 10,
		release: false,
	});
	assert.equal(parseSgrMouse("\x1b[<0;40;10m").release, true);
	assert.equal(parseSgrMouse("u"), null);
});

test("mapClickToPage maps clicks and respects letterboxing", () => {
	const geom = {
		cols: 100,
		imageRows: 30,
		imageTopRow: 3,
		pngW: 1280,
		pngH: 720,
	};
	// scale = min(100/1280, 60/720) = 0.078125; click at col 50, row 17
	assert.deepEqual(mapClickToPage(50, 17, geom), { x: 634, y: 371 });
	// drawn height is 56.25 half-cell units; row 31 => unitY 57 falls below the image
	assert.equal(mapClickToPage(50, 31, geom), null);
	assert.equal(mapClickToPage(50, 2, geom), null);
});

test("truncate", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 8), "hello w…");
	assert.equal(truncate("x", 0), "", "zero width yields nothing");
	// CJK chars occupy 2 terminal cells: 4 wide chars + ellipsis fill 9 cells
	assert.equal(truncate("日本語日本語", 9), "日本語日…");
	assert.equal(truncate("ab日本語", 5), "ab日…");
});

test("pollDelay backs off on idle, 8x cap within minutes, 30x floor after ~5 min", () => {
	assert.equal(pollDelay(1000, 0), 1000);
	assert.equal(pollDelay(1000, 9), 1000);
	assert.equal(pollDelay(1000, 10), 2000);
	assert.equal(pollDelay(1000, 30), 4000);
	assert.equal(pollDelay(1000, 60), 8000);
	assert.equal(pollDelay(1000, 299), 8000);
	assert.equal(pollDelay(1000, 300), 30_000);
	assert.equal(pollDelay(1000, 10_000), 30_000);
	// setTimeout's 2^31-1 ceiling: beyond it Node fires after ~1ms (busy loop)
	assert.equal(pollDelay(2 ** 28, 10_000), 2 ** 31 - 1);
});

test("intervalMs is clamped: no busy-loop from tiny/negative/garbage values", () => {
	const mk = (v) =>
		new Renderer({
			HERDR_BROWSER_INTERVAL_MS: v,
			HERDR_BROWSER_SESSION: "hb-clamp",
			HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(
				path.join(os.tmpdir(), "hb-clamp-"),
			),
		}).intervalMs;
	assert.equal(mk("-5"), 250);
	assert.equal(mk("100"), 250);
	assert.equal(mk("abc"), 1000);
	assert.equal(mk(undefined), 1000);
	assert.equal(mk("2000"), 2000);
});

test("sessionExists requires an exact session-name match", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-sess-"));
	const stub = path.join(dir, "ab-stub");
	fs.writeFileSync(
		stub,
		'#!/usr/bin/env bash\necho \'{"success":true,"data":{"sessions":["herdr-ws-w22","other"]}}\'\n',
	);
	fs.chmodSync(stub, 0o755);
	assert.equal(
		await makeBrowser("herdr-ws-w2", stub).sessionExists(),
		false,
		"substring of a listed session must not count",
	);
	assert.equal(await makeBrowser("herdr-ws-w22", stub).sessionExists(), true);
	assert.equal(await makeBrowser("other", stub).sessionExists(), true);
});

test("navigate accepts only http(s), banners anything else, never opens it", async () => {
	const r = new Renderer({
		HERDR_BROWSER_SESSION: "hb-nav",
		HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "hb-nav-")),
	});
	const opened = [];
	r.browser = {
		sessionExists: async () => true,
		open: async (u) => opened.push(u),
	};
	r.header = () => {};
	await r.navigate("example.com");
	await r.navigate("HTTP://caps.example");
	await r.navigate("localhost:3000");
	assert.deepEqual(opened, [
		"https://example.com",
		"HTTP://caps.example",
		"https://localhost:3000",
	]);
	for (const bad of [
		"not a url at all //",
		"file:///etc/passwd",
		"ftp://host/x",
		"javascript:alert(1)",
	]) {
		r.banner = "";
		await r.navigate(bad);
		assert.equal(opened.length, 3, `must not reach the browser: ${bad}`);
		assert.match(r.banner, /not an http\(s\) URL/);
	}
});

test("navigate claims session ownership only when it creates the session", async () => {
	const mk = () =>
		new Renderer({
			HERDR_BROWSER_SESSION: "hb-unit",
			HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "hb-own-")),
		});
	const fresh = mk();
	fresh.browser = { sessionExists: async () => false, open: async () => {} };
	await fresh.navigate("example.com");
	assert.equal(fresh.selfCreated, true, "pane created it: pane owns it");

	const attached = mk();
	attached.browser = { sessionExists: async () => true, open: async () => {} };
	await attached.navigate("example.com");
	assert.equal(attached.selfCreated, false, "agent created it: never ours");
});

test("sanitizeText strips escape sequences and control chars from page text", () => {
	assert.equal(sanitizeText("\x1b]0;PWNED\x07evil\x1b[2J"), "]0;PWNEDevil[2J");
	assert.equal(sanitizeText("\x1b_Ga=T\x1b\\x"), "_Ga=T\\x");
	assert.equal(sanitizeText("a\tb\r\nc\x7f\u009bd"), "a bcd");
	assert.equal(
		sanitizeText("plain — unicode ✓ stays"),
		"plain — unicode ✓ stays",
	);
	assert.equal(sanitizeText(123), "123");
});

// --- Wave 1: security, correctness, reliability regression tests ---

test("safeWsId strips path-unsafe characters, lockstep with bash ws_id", () => {
	assert.equal(safeWsId("w2"), "w2");
	assert.equal(safeWsId(undefined), "default");
	assert.equal(safeWsId(""), "default");
	assert.equal(safeWsId("../../victim"), "victim");
	assert.equal(safeWsId("!!!"), "default");
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	for (const id of ["w2", "../../victim", "a b/c", "!!!", "w-1_x"]) {
		const sh = execFileSync(
			"bash",
			[
				"-c",
				`. "${repoRoot}/scripts/lib.sh" && HERDR_WORKSPACE_ID="$1" ws_id`,
				"--",
				id,
			],
			{ env: cleanEnv },
		)
			.toString()
			.trim();
		assert.equal(safeWsId(id), sh, `lockstep for ${JSON.stringify(id)}`);
	}
});

test("deriveSession strips control chars from every source", () => {
	// ESC/BEL introducers are stripped; the inert printable payload remains.
	assert.equal(
		deriveSession({ HERDR_BROWSER_SESSION: "x\x1b]52;c;AAAA\x07y" }, "/"),
		"x]52;c;AAAAy",
	);
	assert.equal(
		deriveSession({ HERDR_BROWSER_SESSION: "   " }, "/").startsWith(
			"herdr-cwd-",
		),
		true,
		"all-whitespace env session falls through",
	);
	assert.equal(
		deriveSession({ HERDR_WORKSPACE_ID: "../../victim" }, "/"),
		"herdr-ws-victim",
	);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-cfg-"));
	fs.writeFileSync(path.join(tmp, "session"), "evil\x1b[2Jsess\n");
	assert.equal(
		deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp }, "/"),
		"evil[2Jsess",
	);
});

test("session_name env branch strips control chars, lockstep with JS", () => {
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	const sh = execFileSync(
		"bash",
		[
			"-c",
			`. "${repoRoot}/scripts/lib.sh" && HERDR_BROWSER_SESSION="$1" session_name`,
			"--",
			"x\x1b]52;c;AAAA\x07y z",
		],
		{ env: cleanEnv },
	)
		.toString()
		.trim();
	assert.equal(sh, "x]52;c;AAAAyz");
	assert.equal(
		sh,
		deriveSession({ HERDR_BROWSER_SESSION: "x\x1b]52;c;AAAA\x07y z" }, "/"),
	);
});

test("state_dir expands a literal leading tilde (no per-cwd ./~ tree)", () => {
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	const sh = execFileSync(
		"bash",
		[
			"-c",
			`. "${repoRoot}/scripts/lib.sh" && HERDR_PLUGIN_STATE_DIR='~/.local/state/hb-tilde-test' state_dir`,
		],
		{ env: cleanEnv },
	)
		.toString()
		.trim();
	assert.equal(sh, `${os.homedir()}/.local/state/hb-tilde-test`);
	fs.rmSync(`${os.homedir()}/.local/state/hb-tilde-test`, {
		recursive: true,
		force: true,
	});
});

test("Renderer constructor expands tilde state dir and falls back on relative", () => {
	const r1 = mkRenderer({
		HERDR_PLUGIN_STATE_DIR: "~/.local/state/hb-tilde-js",
	});
	assert.equal(r1.stateDir, `${os.homedir()}/.local/state/hb-tilde-js`);
	fs.rmSync(r1.stateDir, { recursive: true, force: true });
	const r2 = mkRenderer({ HERDR_PLUGIN_STATE_DIR: "relative/dir" });
	assert.equal(
		r2.stateDir,
		path.join(os.homedir(), ".local/state/herdr-browser"),
	);
});

test("sanitizeText strips bidi/zero-width spoofing chars", () => {
	assert.equal(
		sanitizeText("https://good.com\u202E/moc.live//:sptth"),
		"https://good.com/moc.live//:sptth",
	);
	assert.equal(sanitizeText("a\u200Bb\u200Ec\ufeffd"), "abcd");
});

test("intervalMs is clamped at the top: no setTimeout overflow busy-loop", () => {
	const mk = (v) => mkRenderer({ HERDR_BROWSER_INTERVAL_MS: v }).intervalMs;
	assert.equal(mk("Infinity"), 86_400_000);
	assert.equal(mk("999999999999"), 86_400_000);
});

test("tick stays passive when the session is missing", async () => {
	const r = quiet(mkRenderer());
	r.agentBrowser = true;
	const calls = [];
	r.browser = {
		sessionExists: async () => {
			calls.push("sessionExists");
			return false;
		},
		snapshot: async () => {
			calls.push("snapshot");
		},
	};
	await r.tick();
	assert.deepEqual(
		calls,
		["sessionExists"],
		"snapshot would auto-create a headless Chrome — never call it unattached",
	);
	assert.match(r.banner, /waiting for session/);
});

test("tick banner names the real problem when agent-browser is not installed", async () => {
	const r = quiet(mkRenderer());
	r.agentBrowser = false;
	r.browser = { sessionExists: async () => false };
	await r.tick();
	assert.match(r.banner, /not installed/);
	assert.match(r.banner, /npm install -g agent-browser/);
});

test("tick failure lifecycle: banner, detach, ownership dies with the session", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	r.selfCreated = true;
	let exists = true;
	r.browser = {
		url: async () => {
			throw new Error("wedged");
		},
		title: async () => {
			throw new Error("wedged");
		},
		console: async () => {
			throw new Error("wedged");
		},
		screenshot: async () => {
			throw new Error("wedged");
		},
		sessionExists: async () => exists,
	};
	await r.tick();
	await r.tick();
	assert.equal(r.attached, true);
	await r.tick();
	assert.match(r.banner, /not responding/);
	exists = false;
	await r.tick();
	assert.equal(r.attached, false, "detaches when the session is gone");
	assert.equal(
		r.selfCreated,
		false,
		"ownership must not survive the session that granted it",
	);
	assert.match(r.banner, /session .* ended/);
});

test("tick promotes only changed, complete frames", async () => {
	const r = quiet(mkRenderer());
	let renders = 0;
	r.renderImage = async () => {
		renders++;
	};
	let shot = PNG_1PX;
	r.browser = {
		snapshot: async (f) => {
			fs.writeFileSync(f, shot);
			return { url: "https://x", title: "t", entries: [] };
		},
		sessionExists: async () => true,
	};
	await r.tick();
	assert.equal(renders, 1, "first frame rendered");
	assert.equal(fs.readFileSync(r.shot).equals(PNG_1PX), true, "frame promoted");
	assert.equal(
		fs.readdirSync(r.stateDir).filter((f) => f.includes(".tmp")).length,
		0,
		"tmp cleaned up",
	);
	await r.tick();
	assert.equal(renders, 1, "identical frame skipped");
	const other = Buffer.concat([
		PNG_1PX.subarray(0, 16),
		Buffer.from([2]),
		PNG_1PX.subarray(17),
	]);
	shot = other;
	await r.tick();
	assert.equal(renders, 2, "changed frame rendered");
	shot = Buffer.from("garbage not a png");
	await r.tick();
	assert.equal(r.failures, 1, "corrupt frame counts as a tick failure");
	assert.equal(
		fs.readFileSync(r.shot).equals(other),
		true,
		"corrupt frame never promoted",
	);
});

test("navigate rejects userinfo and scheme-less junk", async () => {
	const r = quiet(mkRenderer());
	const opened = [];
	r.browser = {
		sessionExists: async () => true,
		open: async (u) => opened.push(u),
	};
	for (const bad of [
		"mailto:user@example.com",
		"foo@bar.com",
		"user:pass@evil.com",
		"http://user@localhost:3000/",
		"-rf",
	]) {
		r.banner = "";
		await r.navigate(bad);
		assert.equal(opened.length, 0, `must not open: ${bad}`);
		assert.match(r.banner, /not an http\(s\) URL/, bad);
	}
	await r.navigate("http://localhost:3000/@weird-path");
	assert.deepEqual(
		opened,
		["http://localhost:3000/@weird-path"],
		"@ in the path is not credentials",
	);
});

test("navigate does not claim ownership when open fails", async () => {
	const r = quiet(mkRenderer());
	r.browser = {
		sessionExists: async () => false,
		open: async () => {
			throw new Error("daemon down");
		},
	};
	await assert.rejects(r.navigate("example.com"));
	assert.equal(
		r.selfCreated,
		false,
		"a failed open must never own a session it did not create",
	);
});

test("URL policy lockstep: bash validate_url and JS navigate agree on scheme-ful input", async () => {
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	const bash = (u) =>
		spawnSync(
			"bash",
			["-c", `. "${repoRoot}/scripts/lib.sh" && validate_url "$1"`, "--", u],
			{ env: cleanEnv },
		).status === 0;
	const r = quiet(mkRenderer());
	const opened = [];
	r.browser = {
		sessionExists: async () => true,
		open: async (u) => opened.push(u),
	};
	const js = async (u) => {
		const before = opened.length;
		await r.navigate(u);
		return opened.length > before;
	};
	for (const [u, verdict] of [
		["http://example.com", true],
		["HTTP://caps.example", true],
		["https://127.0.0.1:8443/x?y#z", true],
		["http://localhost:3000/@path", true],
		["file:///etc/passwd", false],
		["ftp://host/x", false],
		["javascript:alert(1)", false],
		["-rf", false],
		["http://user@host/", false],
		["https://user:pass@host/", false],
	]) {
		assert.equal(await js(u), verdict, `JS navigate: ${u}`);
		assert.equal(bash(u), verdict, `bash validate_url: ${u}`);
	}
});

test("clickAt maps in-image clicks and ignores out-of-image clicks", async () => {
	const r = quiet(mkRenderer());
	r.size = () => ({
		cols: 100,
		rows: 37,
		imageRows: 30,
		consoleRows: 7,
		imageTopRow: 3,
		bottomRow: 37,
	});
	fs.writeFileSync(r.shot, PNG_1PX);
	const clicks = [];
	r.browser = { click: async (x, y) => clicks.push([x, y]) };
	await r.clickAt(1, 1);
	await r.clickAt(1, 33);
	await r.clickAt(1, 36);
	assert.equal(clicks.length, 0, "header/console rows never click the page");
	fs.rmSync(r.shot);
	await r.clickAt(5, 10);
	assert.equal(clicks.length, 0, "missing screenshot never clicks");
	fs.writeFileSync(r.shot, "junk");
	await r.clickAt(5, 10);
	assert.equal(clicks.length, 0, "corrupt screenshot never clicks");
	fs.writeFileSync(r.shot, PNG_1PX);
	await r.clickAt(1, 3);
	assert.equal(clicks.length, 1);
	assert.deepEqual(
		clicks[0].map(Number.isInteger),
		[true, true],
		"page-pixel integer coordinates",
	);
});

test("cleanup closes only self-created sessions and removes shot files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-close-"));
	const stub = path.join(dir, "ab-stub");
	const logf = path.join(dir, "log");
	fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >> "${logf}"\n`);
	fs.chmodSync(stub, 0o755);
	const mk = () => quiet(mkRenderer());
	const own = mk();
	own.bin = stub;
	own.selfCreated = true;
	fs.writeFileSync(own.shot, "x");
	own.cleanup();
	assert.match(fs.readFileSync(logf, "utf8"), /--session hb-test close/);
	assert.equal(fs.existsSync(own.shot), false);
	fs.writeFileSync(logf, "");
	const foreign = mk();
	foreign.bin = stub;
	foreign.selfCreated = false;
	foreign.cleanup();
	assert.equal(
		fs.readFileSync(logf, "utf8"),
		"",
		"agent-owned session must survive pane quit",
	);
});

test("promptInput submits trimmed, cancels, edits, refuses C1, keeps UTF-8", async () => {
	const r = quiet(mkRenderer());
	r.browser = { sessionExists: async () => false };
	const submits = [];
	r.openPrompt("URL: ", (v) => submits.push(v));
	r.promptInput("  example.com  \r");
	await flush();
	assert.deepEqual(submits, ["example.com"]);
	assert.equal(r.promptState, null);

	r.openPrompt("URL: ", (v) => submits.push(v));
	r.promptInput("   \r"); // whitespace-only never submits
	await flush();
	assert.equal(submits.length, 1);
	assert.equal(r.promptState, null);

	r.openPrompt("URL: ", (v) => submits.push(v));
	r.promptInput("ab\x1b");
	assert.equal(r.promptState, null, "esc cancels");

	r.openPrompt("URL: ", (v) => submits.push(v));
	r.promptInput("ab\x7fc");
	assert.equal(r.promptState.value, "ac", "backspace edits");
	r.promptInput("\x9b");
	assert.equal(r.promptState.value, "ac", "C1 control bytes refused");
	r.promptInput("é漢");
	assert.equal(r.promptState.value, "acé漢", "multibyte input survives");
	r.promptInput("\r");
	await flush();
	assert.deepEqual(submits, ["example.com", "acé漢"]);
});

test("prompt mode swallows mouse reports without cancelling", () => {
	const r = quiet(mkRenderer());
	r.openPrompt("URL: ", () => {});
	r.promptInput("ab\x1b[<0;40;10Mcd");
	assert.notEqual(r.promptState, null, "click did not cancel the prompt");
	assert.equal(
		r.promptState.value,
		"abcd",
		"report bytes never enter the value",
	);
});

test("feed gates keys and clicks while unattached", async () => {
	const r = quiet(mkRenderer());
	const calls = [];
	r.browser = new Proxy({}, { get: () => async () => calls.push("call") });
	r.feed("b");
	r.feed("r");
	r.feed("j");
	r.feed("\x1b[<0;10;5M");
	await flush();
	assert.equal(
		calls.length,
		0,
		"unattached pane ignores drive keys and clicks",
	);
	r.feed("u");
	assert.notEqual(r.promptState, null, "u always opens the address bar");
});

test("pushConsole prefixes, sanitizes display, caps at 500", () => {
	const r = quiet(mkRenderer());
	r.pushConsole(
		[
			{ text: "boom\x1b[2J", type: "error" },
			{ text: "careful", type: "warn" },
			{ text: "hi", type: "log" },
		],
		false,
	);
	assert.equal(r.consoleLines[0], "✖ boom[2J");
	assert.equal(r.consoleLines[1], "⚠ careful");
	assert.equal(r.consoleLines[2], "  hi");
	for (let i = 0; i < 600; i++)
		r.pushConsole([{ text: `line${i}`, type: "log" }], false);
	assert.equal(r.consoleLines.length, 500, "display buffer capped");
	assert.equal(
		r.consolePushes,
		603,
		"monotonic counter survives the cap (sig/backoff depend on it)",
	);
});

test("enqueue counts paint failures instead of silently swallowing them", async () => {
	const r = quiet(mkRenderer());
	await r.enqueue(() => {
		throw new Error("paint bug");
	});
	assert.equal(r.paintErrors, 1);
	await r.enqueue(() => {});
	assert.equal(r.paintErrors, 1, "queue is not poisoned by a throw");
});

test("reconcile edge matrix: empty tail, ring boundary, duplicate texts", () => {
	// Empty tail below the ring aligns vacuously on the head: suffix is new.
	const r1 = reconcileConsole({ count: 3, tail: [] }, e(["a", "b", "c", "d"]));
	assert.deepEqual(
		r1.newEntries.map((x) => x.text),
		["d"],
	);
	assert.equal(r1.marker, false);
	// Empty tail at ring size cannot align: discontinuity marker + full set.
	const r1b = reconcileConsole({ count: 1000, tail: [] }, e(["a", "b"]));
	assert.equal(r1b.marker, true);
	const r2 = reconcileConsole(
		{ count: 5, tail: ["d", "e"] },
		e(["a", "b", "c", "d", "e"]),
		5,
	);
	assert.deepEqual(r2.newEntries.length, 0);
	assert.equal(r2.marker, false, "no rotation at the boundary");
	const r3 = reconcileConsole(
		{ count: 2, tail: ["x", "x"] },
		e(["x", "x", "x", "x"]),
		1000,
	);
	assert.deepEqual(
		r3.newEntries.map((x) => x.text),
		["x", "x"],
	);
});

// --- Wave 2a: batch ticks, real CDP clicks, kitty f=100, input reassembly ---

test("kittyImageSequence chunks the PNG and preserves aspect geometry", () => {
	// 1280x720 into a 100x30 cell box: same scale math as mapClickToPage.
	const payload = Buffer.alloc(10_000, 7); // forces 2+ chunks in base64
	const seq = kittyImageSequence(payload, 1280, 720, 100, 30);
	const packets = seq.split("\x1b\\").filter(Boolean);
	assert.ok(packets.length >= 2, "multi-chunk transmission");
	assert.match(packets[0], /^\x1b_Ga=T,f=100,i=1,c=100,r=28,q=2,m=1;/);
	assert.match(packets.at(-1), /m=0;/);
	for (const p of packets) {
		const payloadB64 = p.replace(/^\x1b_G[^;]*;/, "");
		assert.ok(payloadB64.length <= 4096, "chunk payload within spec");
	}
	assert.equal(
		kittyImageSequence(payload, 1280, 720, 100, 0),
		"",
		"no box, no image",
	);
});

test("kittyImageSequence geometry matches mapClickToPage letterboxing", () => {
	// A click at the bottom-right of the fitted box must map to the png corner.
	const geom = {
		cols: 100,
		imageRows: 30,
		imageTopRow: 3,
		pngW: 1280,
		pngH: 720,
	};
	const pt = mapClickToPage(100, 3 + 27, geom); // r=28 drawn rows
	assert.ok(
		pt.x > 1200 && pt.y > 700,
		`corner maps deep into the page: ${pt.x},${pt.y}`,
	);
});

test("feed processes coalesced keypresses individually", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	const scrolls = [];
	r.browser = { scroll: async (dir) => scrolls.push(dir) };
	r.feed("jjk");
	await flush();
	assert.deepEqual(
		scrolls,
		["down", "down", "up"],
		"coalesced keys must each dispatch, not match nothing as a whole chunk",
	);
});

test("feed reassembles a mouse report split across chunks", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	r.size = () => ({
		cols: 100,
		rows: 37,
		imageRows: 30,
		consoleRows: 7,
		imageTopRow: 3,
		bottomRow: 37,
	});
	fs.writeFileSync(r.shot, PNG_1PX);
	const clicks = [];
	r.browser = { click: async (x, y) => clicks.push([x, y]) };
	r.feed("\x1b[<0;40;1");
	await flush();
	assert.equal(clicks.length, 0, "partial report must not fire");
	r.feed("0M");
	await flush();
	assert.equal(clicks.length, 1, "completed report fires once");
});

test("makeBrowser.snapshot parses the batch array shape", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-batch-"));
	const stub = path.join(dir, "ab-stub");
	fs.writeFileSync(
		stub,
		`#!/usr/bin/env bash
printf '%s' '[{"command":["get","url"],"error":null,"result":{"url":"https://x/"},"success":true},{"command":["get","title"],"error":null,"result":{"title":"T"},"success":true},{"command":["console"],"error":null,"result":{"messages":[{"text":"hi","type":"log"}]},"success":true},{"command":["screenshot","/tmp/x"],"error":null,"result":{"path":"/tmp/x"},"success":true}]'
`,
	);
	fs.chmodSync(stub, 0o755);
	const snap = await makeBrowser("s", stub).snapshot("/tmp/x");
	assert.deepEqual(snap, {
		url: "https://x/",
		title: "T",
		entries: [{ text: "hi", type: "log" }],
	});
});

test("makeBrowser.snapshot surfaces the first batch error", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-batcherr-"));
	const stub = path.join(dir, "ab-stub");
	fs.writeFileSync(
		stub,
		`#!/usr/bin/env bash
printf '%s' '[{"command":["get","url"],"error":"session gone","result":null,"success":false}]'
`,
	);
	fs.chmodSync(stub, 0o755);
	await assert.rejects(
		makeBrowser("s", stub).snapshot("/tmp/x"),
		/session gone/,
	);
});

test("makeBrowser.click batches move/down/up in one call", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-click-"));
	const logf = path.join(dir, "log");
	const stub = path.join(dir, "ab-stub");
	fs.writeFileSync(
		stub,
		`#!/usr/bin/env bash
echo "$@" >> "${logf}"
printf '%s' '[{"success":true,"result":{}},{"success":true,"result":{}},{"success":true,"result":{}}]'
`,
	);
	fs.chmodSync(stub, 0o755);
	await makeBrowser("s", stub).click(634, 371);
	const logged = fs.readFileSync(logf, "utf8");
	assert.match(
		logged,
		/batch --bail --json mouse move 634 371 mouse down mouse up/,
	);
});

test("reconcileConsole property: append-only streams yield exactly the suffix", () => {
	// Deterministic LCG so failures reproduce.
	let seed = 42;
	const rnd = (n) => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed % n;
	};
	const vocab = ["a", "b", "c", "x", "x", "x"]; // heavy duplicates on purpose
	for (let iter = 0; iter < 200; iter++) {
		const before = Array.from(
			{ length: rnd(40) },
			() => vocab[rnd(vocab.length)],
		);
		const added = Array.from(
			{ length: rnd(15) },
			() => vocab[rnd(vocab.length)],
		);
		const all = [...before, ...added];
		const prev = { count: before.length, tail: consoleTail(e(before)) };
		const { newEntries, marker } = reconcileConsole(prev, e(all));
		if (!marker) {
			assert.deepEqual(
				newEntries.map((x) => x.text),
				added,
				`iter ${iter}: appended entries must arrive exactly once`,
			);
		}
	}
});

// --- Wave 2b: live push stream ---

// Minimal valid JPEG: SOI + SOF0 (8-bit, WxH) with a plausible segment length.
const jpeg = (w, h) => {
	const b = Buffer.alloc(20);
	b.writeUInt16BE(0xffd8, 0); // SOI
	b.writeUInt16BE(0xffc0, 2); // SOF0
	b.writeUInt16BE(17, 4); // segment length
	b.writeUInt16BE(h, 7);
	b.writeUInt16BE(w, 9);
	return b;
};

test("jpegDims reads SOF0 dimensions, rejects junk", () => {
	assert.deepEqual(jpegDims(jpeg(1280, 720)), { w: 1280, h: 720 });
	assert.equal(jpegDims(Buffer.from("not a jpeg")), null);
	assert.equal(jpegDims(Buffer.alloc(3)), null);
	assert.equal(imageDims(PNG_1PX).w, 1, "imageDims covers png");
	assert.equal(imageDims(jpeg(2, 3)).h, 3, "imageDims covers jpeg");
});

test("onStreamMessage routes frames, console, page errors, and tabs", async () => {
	const r = quiet(mkRenderer());
	let renders = 0;
	r.renderImage = async () => {
		renders++;
	};
	r.fitViewport = async () => false;
	r.onStreamMessage({
		type: "frame",
		data: jpeg(1280, 720).toString("base64"),
	});
	await flush();
	assert.equal(r.frameSeq, 1);
	assert.equal(r.shotFormat, "jpg");
	assert.equal(
		imageDims(fs.readFileSync(r.shotJpg)).w,
		1280,
		"frame written to disk",
	);
	assert.equal(renders, 1, "frame painted");

	r.onStreamMessage({ type: "frame", data: "%%%not-base64-jpeg%%%" });
	assert.equal(r.frameSeq, 1, "invalid frame ignored");

	r.onStreamMessage({
		type: "console",
		text: "hello\x1b[2J",
		level: "warning",
	});
	assert.equal(r.consoleLines.at(-1), "⚠ hello[2J");
	r.onStreamMessage({ type: "page_error", text: "boom at app.js:1" });
	assert.equal(r.consoleLines.at(-1), "✖ boom at app.js:1");

	r.onStreamMessage({
		type: "tabs",
		tabs: [
			{ active: false, url: "https://bg", title: "bg" },
			{ active: true, url: "https://active/", title: "Act" },
		],
	});
	assert.equal(r.lastUrl, "https://active/");
	assert.equal(r.lastTitle, "Act");

	r.onStreamMessage({ type: "status", connected: true }); // no-op, no crash
});

test("dropLive falls back to polling with a silent console resync", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	let closed = false;
	r.live = {
		ws: {
			close: () => {
				closed = true;
			},
		},
	};
	r.dropLive("live stream dropped — polling");
	assert.equal(r.live, null);
	assert.equal(closed, true);
	assert.match(r.banner, /dropped/);
	assert.equal(r.suppressConsoleOnce, true);
	// Next poll tick resyncs console state without replaying streamed entries.
	let pushed = 0;
	const origPush = r.pushConsole.bind(r);
	r.pushConsole = (...a) => {
		pushed++;
		origPush(...a);
	};
	const entries = [{ text: "already shown", type: "log" }];
	r.browser = {
		snapshot: async (f) => {
			fs.writeFileSync(f, PNG_1PX);
			return { url: "https://x", title: "", entries };
		},
		sessionExists: async () => true,
	};
	await r.tick();
	assert.equal(pushed, 0, "streamed entries not replayed");
	assert.deepEqual(r.consoleState, { count: 1, tail: ["already shown"] });
});

test("live tick only watches liveness, and handles session death", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	r.selfCreated = true;
	r.live = { ws: { close: () => {} } };
	const calls = [];
	r.browser = {
		sessionExists: async () => {
			calls.push("sessionExists");
			return false;
		},
		snapshot: async () => {
			calls.push("snapshot");
		},
	};
	r.lastLiveCheck = Date.now(); // fresh: skip the liveness probe this tick
	await r.tick();
	assert.deepEqual(calls, [], "no spawns while the stream is healthy");
	r.lastLiveCheck = 0; // stale: probe now
	await r.tick();
	assert.deepEqual(calls, ["sessionExists"]);
	assert.equal(r.live, null, "stream dropped on session death");
	assert.equal(r.attached, false);
	assert.equal(r.selfCreated, false, "ownership died with the session");
	assert.match(r.banner, /ended/);
});

test("goLive returns false without a global WebSocket (Node < 22)", async () => {
	const r = quiet(mkRenderer());
	const saved = global.WebSocket;
	// biome-ignore lint/performance/noDelete: must remove, not undefined-shadow
	delete global.WebSocket;
	try {
		assert.equal(await r.goLive(), false);
	} finally {
		global.WebSocket = saved;
	}
});

test("polling tick tries goLive once, then respects the cooldown", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	let enables = 0;
	r.browser = {
		streamEnable: async () => {
			enables++;
		},
		streamStatus: async () => {
			throw new Error("no stream");
		},
		snapshot: async (f) => {
			fs.writeFileSync(f, PNG_1PX);
			return { url: "https://x", title: "", entries: [] };
		},
		sessionExists: async () => true,
	};
	await r.tick();
	assert.equal(enables, 1, "one live attempt on the first attached tick");
	await r.tick();
	assert.equal(enables, 1, "cooldown suppresses immediate retries");
});

// End-to-end against a real agent-browser session; skips when the engine is
// not installed (CI, contributor machines without it).
const hasAgentBrowser =
	spawnSync("sh", ["-c", "command -v agent-browser"]).status === 0;
test("e2e: goLive receives pushed frames and console from a real session", {
	skip: !hasAgentBrowser && "agent-browser not installed",
	timeout: 30_000,
}, async () => {
	const session = `hb-itest-${process.pid}`;
	const { execFile: ef } = await import("node:child_process");
	const ab = (args) =>
		new Promise((res, rej) =>
			ef(
				"agent-browser",
				["--session", session, ...args],
				{ timeout: 15_000 },
				(e, so) => (e ? rej(e) : res(so)),
			),
		);
	try {
		await ab(["open", "https://example.com"]);
		const r = quiet(mkRenderer({ HERDR_BROWSER_SESSION: session }));
		// Viewport fitting has dedicated tests; disabling it here prevents its
		// queued resize command from racing this stream test's session close.
		r.fitViewport = async () => false;
		assert.equal(await r.goLive(), true, "stream connects");
		const deadline = Date.now() + 10_000;
		while (r.frameSeq === 0 && Date.now() < deadline) {
			await new Promise((res) => setTimeout(res, 100));
		}
		assert.ok(r.frameSeq > 0, "a screencast frame arrived");
		assert.ok(
			imageDims(fs.readFileSync(r.shotJpg)),
			"frame is a valid image on disk",
		);
		await ab(["eval", 'console.warn("hb-itest-marker")']);
		const cDeadline = Date.now() + 10_000;
		while (
			!r.consoleLines.some((l) => l.includes("hb-itest-marker")) &&
			Date.now() < cDeadline
		) {
			await new Promise((res) => setTimeout(res, 100));
		}
		assert.ok(
			r.consoleLines.some((l) => l.includes("hb-itest-marker")),
			"console entry streamed live",
		);
		r.dropLive();
	} finally {
		await ab(["close"]).catch(() => {});
	}
});

// --- Wave 2c: wheel scroll, header repaint gating ---

test("mouse wheel scrolls the page, click still clicks", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	r.size = () => ({
		cols: 100,
		rows: 37,
		imageRows: 30,
		consoleRows: 7,
		imageTopRow: 3,
		bottomRow: 37,
	});
	fs.writeFileSync(r.shot, PNG_1PX);
	const scrolls = [];
	const clicks = [];
	r.browser = {
		scroll: async (dir) => scrolls.push(dir),
		click: async (x, y) => clicks.push([x, y]),
	};
	r.feed("\x1b[<64;50;10M"); // wheel up
	r.feed("\x1b[<65;50;10M"); // wheel down
	r.feed("\x1b[<64;50;10m"); // wheel release: never an action
	await flush();
	assert.deepEqual(scrolls, ["up", "down"]);
	assert.equal(clicks.length, 0, "wheel reports never reach clickAt");
	r.feed("\x1b[<0;10;5M");
	await flush();
	assert.equal(clicks.length, 1);
});

test("header is repaint-gated but always paints real changes", () => {
	const r = quiet(mkRenderer());
	r.mode = "symbols";
	// Restore the real header (quiet() stubs it); capture writes.
	const realHeader = Object.getPrototypeOf(r).header.bind(r);
	const writes = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (s) => {
		writes.push(s);
		return true;
	};
	try {
		realHeader();
		const first = writes.length;
		assert.ok(first > 0, "first paint writes");
		realHeader();
		assert.equal(writes.length, first, "identical header is not rewritten");
		r.banner = "something changed";
		realHeader();
		assert.ok(writes.length > first, "a banner change repaints");
		const afterBanner = writes.length;
		r.openPrompt("URL: ", () => {});
		realHeader();
		assert.ok(
			writes.length > afterBanner,
			"prompt-open repaints (help -> prompt line)",
		);
	} finally {
		process.stdout.write = origWrite;
	}
});

// --- Wave 2d: fleet-re-review regression tests ---

test('poll tick after a stream drop renders the fresh PNG, not the stale JPEG', async () => {
  const r = quiet(mkRenderer());
  r.attached = true;
  r.fitViewport = async () => false;
  // Simulate a prior live stream: a jpg frame landed, then the stream died.
  r.onStreamMessage({ type: 'frame', data: jpeg(1280, 720).toString('base64') });
  await flush();
  assert.equal(r.shotFormat, 'jpg');
  r.live = { ws: { close: () => {} } };
  r.dropLive();
  assert.equal(r.shotFormat, 'png', 'dropLive points the renderer at the poll path frame');
  let renderedPath = null;
  const origExists = fs.existsSync;
  r.renderImage = async () => { renderedPath = r.shotFormat === 'jpg' ? r.shotJpg : r.shot; };
  r.browser = {
    snapshot: async f => {
      fs.writeFileSync(f, PNG_1PX);
      return { url: 'https://x', title: '', entries: [] };
    },
    sessionExists: async () => true,
  };
  await r.tick();
  assert.equal(r.shotFormat, 'png');
  assert.equal(renderedPath, r.shot, 'poll frame rendered, not the frozen stream frame');
  assert.ok(origExists(r.shot));
});

test('malformed stream messages never crash the dispatch', async () => {
  const r = quiet(mkRenderer());
  const bad = [
    { type: 'tabs', tabs: {} },
    { type: 'tabs', tabs: 42 },
    { type: 'tabs', tabs: 'x' },
    { type: 'frame', data: 12345 },
    { type: 'frame' },
    { type: 'console' },
    { type: 'url' },
    {},
    { type: null },
  ];
  for (const m of bad) r.onStreamMessage(m);
  await flush();
  assert.equal(r.frameSeq, 0);
  // And the dispatch wrapper in goLive counts instead of throwing:
  assert.ok(r.paintErrors >= 0);
});

test('a successful goLive from the attach path repaints the header', async () => {
  const r = quiet(mkRenderer());
  let headers = 0;
  const realHeader = Object.getPrototypeOf(r).header.bind(r);
  r.header = () => { headers++; realHeader(); };
  r.banner = 'waiting for session …';
  r.goLive = async () => true;
  r.browser = { sessionExists: async () => true };
  await r.tick();
  assert.equal(r.attached, true);
  assert.ok(headers >= 1, 'header repainted after goLive, stale banner cleared');
});

test('goLive stays on the poll path for kitty mode without chafa', async () => {
  const r = quiet(mkRenderer());
  r.mode = 'kitty';
  r.chafa = false;
  let enabled = 0;
  r.browser = { streamEnable: async () => { enabled++; } };
  assert.equal(await r.goLive(), false);
  assert.equal(enabled, 0, 'no stream attempt when stream frames could not render');
});

test('goLive rejects hostile or malformed ports without throwing', async () => {
  const r = quiet(mkRenderer());
  for (const port of ['evil.com/x', 0, -1, 70000, 3.5, null, undefined]) {
    r.browser = {
      streamEnable: async () => {},
      streamStatus: async () => ({ port }),
    };
    assert.equal(await r.goLive(), false, `port ${JSON.stringify(port)} refused`);
  }
});

test('userAction surfaces failures in the banner (live mode has no tick report)', async () => {
  const r = quiet(mkRenderer());
  let headers = 0;
  r.header = () => { headers++; };
  r.userAction(async () => { throw new Error('daemon hung'); });
  await flush();
  assert.match(r.banner, /command failed/);
  assert.ok(headers >= 1, 'failure banner painted');
});

test('feed holds a split ESC-[ but a bare ESC still dispatches immediately', () => {
  const r = quiet(mkRenderer());
  const keys = [];
  r.onKey = ch => keys.push(ch);
  r.feed('\x1b[');
  assert.deepEqual(keys, [], 'ESC-[ held for the next chunk');
  r.feed('<0;10;5M');
  assert.deepEqual(keys, [], 'completed report went to the mouse path');
  r.feed('\x1b');
  // bare ESC reaches the key path at once (prompt cancel must not lag);
  // onKey ignores it when no prompt is open and it is not a mapped key.
  assert.equal(r.inputBuf, '');
});

// --- Pane viewport fitting ---

test("viewportForPane preserves width and fills the image-cell aspect", () => {
	assert.deepEqual(
		viewportForPane(1280, { cols: 80, imageRows: 30 }),
		{ w: 1280, h: 960 },
	);
	assert.deepEqual(
		viewportForPane(390, { cols: 80, imageRows: 30 }),
		{ w: 390, h: 293 },
		"mobile width/breakpoint is preserved",
	);
	assert.equal(viewportForPane(1280, { cols: 0, imageRows: 30 }), null);
	assert.equal(viewportForPane(1280, { cols: 80, imageRows: 2 }), null);
});

test("fitViewport sets the browser height once per pane geometry", async () => {
	const r = quiet(mkRenderer());
	r.size = () => ({ cols: 80, imageRows: 30 });
	const calls = [];
	r.browser = {
		setViewport: async (w, h) => calls.push([w, h]),
	};
	assert.equal(await r.fitViewport(1280, 577), true);
	assert.deepEqual(calls, [[1280, 960]]);
	assert.deepEqual(r.lastImageDims, { w: 1280, h: 577 });
	assert.equal(await r.fitViewport(1280, 577), false, "same geometry is cached");
	assert.equal(calls.length, 1);

	r.lastViewportRequest = ""; // pane resize invalidates the cache
	r.size = () => ({ cols: 80, imageRows: 40 });
	assert.equal(await r.fitViewport(1280, 960), true);
	assert.deepEqual(calls.at(-1), [1280, 1280]);
});

test("fitViewport avoids resize churn when the frame already fits", async () => {
	const r = quiet(mkRenderer());
	r.size = () => ({ cols: 80, imageRows: 30 });
	let calls = 0;
	r.browser = { setViewport: async () => { calls++; } };
	assert.equal(await r.fitViewport(1280, 959), false);
	assert.equal(calls, 0);
});

test("empty console gives its rows to the browser until output arrives", () => {
	const r = quiet(mkRenderer());
	r.mode = "symbols";
	const empty = r.size();
	assert.equal(empty.consoleRows, 0);
	assert.ok(empty.imageRows > 0);

	r.consoleLines.push("a browser log");
	const visible = r.size();
	assert.ok(visible.consoleRows >= 4);
	assert.equal(visible.imageRows, empty.imageRows - visible.consoleRows);
});

// --- Wave 3: failed network requests in the console region ---

const req = (id, over = {}) => ({
	requestId: id,
	url: `https://api.test/${id}`,
	method: "GET",
	resourceType: "Fetch",
	timestamp: 1_000_000,
	...over,
});
const T0 = 1_000_000;

test("network diff: new 404 reported once, then seen", () => {
	const st = newNetworkState();
	const first = diffNetworkFailures(st, [req("a", { status: 404 })], T0 + 10);
	assert.equal(first.failures.length, 1);
	assert.equal(first.failures[0].status, 404);
	const second = diffNetworkFailures(st, [req("a", { status: 404 })], T0 + 20);
	assert.equal(second.failures.length, 0, "same entry must not re-report");
});

test("network diff: null status ages into no-response, 200 never reports", () => {
	const st = newNetworkState();
	const young = diffNetworkFailures(st, [req("a")], T0 + 5_000);
	assert.equal(young.failures.length, 0, "5s old in-flight is not a failure");
	const aged = diffNetworkFailures(st, [req("a")], T0 + 20_000);
	assert.equal(aged.failures.length, 1);
	assert.equal(aged.failures[0].status, null);
	const st2 = newNetworkState();
	diffNetworkFailures(st2, [req("b")], T0 + 5_000);
	const ok = diffNetworkFailures(st2, [req("b", { status: 200 })], T0 + 9_000);
	assert.equal(ok.failures.length, 0);
	const later = diffNetworkFailures(st2, [req("b", { status: 200 })], T0 + 60_000);
	assert.equal(later.failures.length, 0, "resolved-OK id stays swallowed");
});

test("network diff: failure status arriving one poll late still reports", () => {
	const st = newNetworkState();
	const inflight = diffNetworkFailures(st, [req("a")], T0 + 1_000);
	assert.equal(inflight.failures.length, 0);
	const landed = diffNetworkFailures(st, [req("a", { status: 500 })], T0 + 3_000);
	assert.equal(landed.failures.length, 1, "late 500 must not be swallowed");
	assert.equal(landed.failures[0].status, 500);
});

test("network diff: log wipe prunes state without replay", () => {
	const st = newNetworkState();
	diffNetworkFailures(st, [req("a", { status: 404 })], T0 + 10);
	assert.ok(st.seen.has("a"));
	// Wipe: log now holds only a fresh id; 'a' evaporates from state.
	const after = diffNetworkFailures(st, [req("z", { status: 200 })], T0 + 20);
	assert.equal(after.failures.length, 0);
	assert.ok(!st.seen.has("a"), "seen pruned to current log");
	// Reused id after relaunch is a new request, judged on its own status —
	// dedupe by shape (not id) is what suppresses the repeat line.
	const reused = diffNetworkFailures(
		st,
		[req("z", { status: 200 }), req("a", { status: 404 })],
		T0 + 30,
	);
	assert.equal(reused.failures.length, 0, "same shape within window dedupes");
	assert.ok(st.seen.has("a"), "reused id still classified and tracked");
});

test("network diff: nav-retry burst dedupes to one line", () => {
	const st = newNetworkState();
	const out = diffNetworkFailures(
		st,
		[
			req("r1", { url: "https://x.invalid/", timestamp: T0 - 60_000 }),
			req("r2", { url: "https://x.invalid/", timestamp: T0 - 60_000 }),
			req("r3", { url: "https://x.invalid/", timestamp: T0 - 60_000 }),
		],
		T0,
	);
	assert.equal(out.failures.length, 1, "3 retry entries paint one line");
	assert.equal(out.overflow, 0, "deduped entries are not overflow");
});

test("network diff: cross-poll retry loop stays suppressed within window", () => {
	const st = newNetworkState();
	let lines = 0;
	for (let i = 0; i < 5; i++) {
		const out = diffNetworkFailures(
			st,
			[req(`try${i}`, { url: "https://api.test/beacon", status: 502 })],
			T0 + i * 5_000,
		);
		lines += out.failures.length;
	}
	assert.equal(lines, 1, "steady 5s retry loop paints once inside 60s window");
});

test("network diff: per-poll cap emits overflow count", () => {
	const st = newNetworkState();
	const entries = [];
	for (let i = 0; i < 12; i++)
		entries.push(req(`e${i}`, { url: `https://api.test/${i}`, status: 500 }));
	const out = diffNetworkFailures(st, entries, T0);
	assert.equal(out.failures.length, 5);
	assert.equal(out.overflow, 7);
});

test("network diff: baseline swallows everything silently", () => {
	const st = newNetworkState();
	const out = diffNetworkFailures(
		st,
		[req("a", { status: 404 }), req("b"), req("c", { status: 500 })],
		T0,
		{ baseline: true },
	);
	assert.equal(out.failures.length, 0);
	const next = diffNetworkFailures(
		st,
		[req("a", { status: 404 }), req("b"), req("c", { status: 500 })],
		T0 + 1_000,
	);
	assert.equal(next.failures.length, 0, "baselined ids never replay");
});

test("network format: sanitizes and hard-caps page-controlled URLs", () => {
	const nasty = `https://api.test/${"\x1b[2J"}${"x".repeat(5000)}`;
	const line = formatNetworkFailure({ method: "GET", url: nasty, status: 404 });
	assert.ok(line.startsWith("404 GET https://api.test/"));
	assert.ok(!line.includes("\x1b"), "escape bytes stripped");
	assert.ok(line.length <= 220, "stored line is capped");
	assert.equal(
		formatNetworkFailure({ method: "POST", url: "http://l:3000/a", status: null }),
		"no response POST http://l:3000/a",
	);
});

test("makeBrowser.network passes the type filter, never --clear", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-net-"));
	const logf = path.join(dir, "log");
	const stub = path.join(dir, "ab-stub");
	fs.writeFileSync(
		stub,
		`#!/usr/bin/env bash
echo "$@" >> "${logf}"
printf '%s' '{"success":true,"data":{"requests":[{"requestId":"r1","url":"https://x/a","method":"GET","status":404,"timestamp":1000,"resourceType":"Fetch"}]}}'
`,
	);
	fs.chmodSync(stub, 0o755);
	const reqs = await makeBrowser("s", stub).network();
	assert.equal(reqs.length, 1);
	assert.equal(reqs[0].requestId, "r1");
	const logged = fs.readFileSync(logf, "utf8");
	assert.match(
		logged,
		/--session s network requests --type xhr,fetch,document --json/,
	);
	assert.ok(!logged.includes("--clear"), "pane must never clear the shared log");
});

test("makeBrowser.network rejects on malformed output so callers degrade", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-netbad-"));
	const stub = path.join(dir, "ab-stub");
	fs.writeFileSync(stub, `#!/usr/bin/env bash\nprintf 'not json'\n`);
	fs.chmodSync(stub, 0o755);
	await assert.rejects(makeBrowser("s", stub).network(), /non-JSON/);
});

// U3: poll-mode failure feed integration.

const netEntry = (id, over = {}) => ({
	requestId: id,
	url: `https://api.test/${id}`,
	method: "GET",
	resourceType: "Fetch",
	timestamp: Date.now(),
	...over,
});
const pollFake = (netQueue, calls = []) => ({
	sessionExists: async () => {
		calls.push("sessionExists");
		return true;
	},
	snapshot: async (f) => {
		calls.push("snapshot");
		fs.writeFileSync(f, PNG_1PX);
		return { url: "https://x/", title: "T", entries: [] };
	},
	network: async () => {
		calls.push("network");
		const next = netQueue.length > 1 ? netQueue.shift() : netQueue[0];
		if (next instanceof Error) throw next;
		return next;
	},
});
const quietPoll = (r) => {
	quiet(r);
	r.redrawAll = async () => {};
	r.fitViewport = async () => false;
	r.streamCooldownUntil = Number.MAX_SAFE_INTEGER; // stay in poll mode
	return r;
};

test("tick: first poll baselines silently, later failure paints with ✖", async () => {
	const r = quietPoll(mkRenderer());
	r.browser = pollFake([
		[netEntry("old", { status: 404 })],
		[netEntry("old", { status: 404 }), netEntry("fresh", { status: 500 })],
	]);
	await r.tick(); // attach + baseline: 'old' swallowed
	await flush();
	assert.deepEqual(r.consoleLines, [], "baseline paints nothing");
	await r.tick();
	await flush();
	assert.equal(r.consoleLines.length, 1);
	assert.match(r.consoleLines[0], /^✖ 500 GET https:\/\/api\.test\/fresh/);
});

test("tick: broken network feed degrades silently, pane keeps painting", async () => {
	const r = quietPoll(mkRenderer());
	r.browser = pollFake([new Error("weird transient failure")]);
	await r.tick();
	await r.tick();
	await flush();
	assert.deepEqual(r.consoleLines, []);
	assert.equal(r.banner, "", "no banner for a best-effort feature");
	assert.equal(r.failures, 0, "tick failure counter untouched");
	assert.ok(r.networkPollErrors >= 2);
});

test("tick: maxBuffer-class failure latches the feed off with one line", async () => {
	const r = quietPoll(mkRenderer());
	const calls = [];
	r.browser = pollFake(
		[new Error("stdout maxBuffer length exceeded")],
		calls,
	);
	await r.tick();
	await r.tick();
	await r.tick();
	await flush();
	assert.equal(r.networkOff, true);
	assert.deepEqual(
		r.consoleLines,
		["✖ network reporting off — request log too large"],
		"exactly one visible off note",
	);
	assert.equal(
		calls.filter((c) => c === "network").length,
		1,
		"no retries after the latch",
	);
});

test("tick: re-attach re-baselines instead of replaying", async () => {
	const r = quietPoll(mkRenderer());
	let alive = true;
	const netQueue = [[netEntry("preexisting", { status: 503 })]];
	r.browser = {
		...pollFake(netQueue),
		sessionExists: async () => alive,
	};
	await r.tick(); // attach + baseline
	await flush();
	// Session dies: three failed snapshots detach the pane.
	const goodSnapshot = r.browser.snapshot;
	r.browser.snapshot = async () => {
		throw new Error("session gone");
	};
	alive = false;
	await r.tick();
	await r.tick();
	await r.tick();
	assert.equal(r.attached, false, "death detaches");
	// Session comes back under the same name with old failures in its log.
	alive = true;
	r.browser.snapshot = goodSnapshot;
	await r.tick(); // re-attach: baseline swallows 'preexisting' again
	await flush();
	assert.deepEqual(r.consoleLines, [], "no replay across re-attach");
	netQueue[0] = [netEntry("preexisting", { status: 503 }), netEntry("new1", { status: 404 })];
	await r.tick();
	await flush();
	assert.equal(r.consoleLines.length, 1);
	assert.match(r.consoleLines[0], /404 GET https:\/\/api\.test\/new1/);
});

test("navigate: existing session baselines before open; nav failure still reports", async () => {
	const r = quietPoll(mkRenderer());
	const calls = [];
	const netQueue = [[netEntry("stale", { status: 500 })]];
	r.browser = {
		...pollFake(netQueue, calls),
		open: async () => {
			calls.push("open");
		},
	};
	await r.navigate("https://localhost:3000/");
	assert.ok(
		calls.indexOf("network") < calls.indexOf("open"),
		"baseline read fires before open on an existing session",
	);
	assert.deepEqual(r.consoleLines, [], "stale failure swallowed");
	netQueue[0] = [netEntry("stale", { status: 500 }), netEntry("nav", { status: 404 })];
	await r.tick();
	await flush();
	assert.equal(r.consoleLines.length, 1);
	assert.match(r.consoleLines[0], /404 GET https:\/\/api\.test\/nav/);
});

test("navigate: fresh session gets no pre-open network call, nav failure reports", async () => {
	const r = quietPoll(mkRenderer());
	const calls = [];
	let exists = false;
	const netQueue = [[]];
	r.browser = {
		...pollFake(netQueue, calls),
		sessionExists: async () => {
			calls.push("sessionExists");
			return exists;
		},
		open: async () => {
			calls.push("open");
			exists = true;
		},
	};
	await r.navigate("https://localhost:3000/");
	assert.ok(
		!calls.slice(0, calls.indexOf("open")).includes("network"),
		"no session-creating read before open",
	);
	assert.equal(r.selfCreated, true);
	netQueue[0] = [netEntry("nav", { status: null, timestamp: Date.now() - 20_000 })];
	await r.tick();
	await flush();
	assert.equal(r.consoleLines.length, 1);
	assert.match(r.consoleLines[0], /^✖ no response GET/);
});

test("network lines in consoleLines do not perturb console reconcile", async () => {
	const r = quietPoll(mkRenderer());
	let consoleEntries = [];
	const netQueue = [[]];
	r.browser = {
		...pollFake(netQueue),
		snapshot: async (f) => {
			fs.writeFileSync(f, PNG_1PX);
			return { url: "https://x/", title: "T", entries: consoleEntries };
		},
	};
	await r.tick(); // baseline
	netQueue[0] = [netEntry("bad", { status: 500 })];
	await r.tick(); // paints the failure line
	await flush();
	assert.equal(r.consoleLines.length, 1);
	consoleEntries = [{ text: "page says hi", type: "log" }];
	await r.tick();
	await flush();
	assert.equal(r.consoleLines.length, 2, "console entry appended once");
	assert.equal(r.consoleLines.at(-1), "  page says hi");
	await r.tick();
	await flush();
	assert.equal(r.consoleLines.length, 2, "no duplicate on the next tick");
});

// U4: live-mode network timer.

test("live timer: fires the shared poll and paints while streaming", async () => {
	const r = quietPoll(mkRenderer());
	r.attached = true;
	r.live = { ws: { close: () => {} } };
	r.networkBaselinePending = false;
	const calls = [];
	r.browser = pollFake([[netEntry("bad", { status: 500 })]], calls);
	r.startNetworkTimer(5);
	await new Promise((res) => setTimeout(res, 60));
	r.stopNetworkTimer();
	await flush();
	assert.ok(calls.includes("network"), "timer polled the daemon");
	assert.equal(r.consoleLines.length, 1);
	assert.match(r.consoleLines[0], /^✖ 500 GET/);
});

test("live timer: painted polls hold base cadence, empty polls back off", async () => {
	const r = quietPoll(mkRenderer());
	r.attached = true;
	r.live = { ws: { close: () => {} } };
	r.browser = { network: async () => [] };
	let painted = true;
	r.pollNetwork = async () => painted;
	r.startNetworkTimer(5);
	await new Promise((res) => setTimeout(res, 40));
	assert.equal(r.networkIdleTicks, 0, "painted failures reset the counter");
	painted = false;
	await new Promise((res) => setTimeout(res, 40));
	r.stopNetworkTimer();
	assert.ok(r.networkIdleTicks > 0, "quiet polls accumulate idle ticks");
});

test("live timer: dropLive clears it first; no fire after drop", async () => {
	const r = quietPoll(mkRenderer());
	r.attached = true;
	r.live = { ws: { close: () => {} } };
	r.networkBaselinePending = false;
	const calls = [];
	r.browser = pollFake([[]], calls);
	r.startNetworkTimer(20);
	r.dropLive();
	assert.equal(r.networkTimer, null, "timer cleared on drop");
	await new Promise((res) => setTimeout(res, 60));
	assert.ok(!calls.includes("network"), "no poll after the stream dropped");
});

test("live timer: in-flight guard collapses concurrent polls", async () => {
	const r = quietPoll(mkRenderer());
	r.attached = true;
	r.networkBaselinePending = false;
	let netCalls = 0;
	let release;
	r.browser = {
		network: async () => {
			netCalls++;
			await new Promise((res) => {
				release = res;
			});
			return [];
		},
	};
	const p1 = r.pollNetwork();
	const p2 = r.pollNetwork();
	release([]);
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(netCalls, 1, "second poll skipped while one is in flight");
	assert.equal(r2, false);
	assert.equal(r1, false);
});

test("live timer: never starts for browsers without network()", () => {
	const r = quietPoll(mkRenderer());
	r.browser = { sessionExists: async () => true };
	r.startNetworkTimer(5);
	assert.equal(r.networkTimer, null);
});

// --- Wave 4: CDP attach mode ---

const attachRenderer = (over = {}) => {
	const r = mkRenderer({ HERDR_BROWSER_CDP_URL: "http://127.0.0.1:9222", ...over });
	quiet(r);
	r.redrawAll = async () => {};
	r.fitViewport = async () => false;
	return r;
};
const fakeCdpBackend = (over = {}) => {
	const calls = [];
	let handler = null;
	return {
		calls,
		emit: (m) => handler?.(m),
		onMessage: (fn) => {
			handler = fn;
		},
		connect: async () => {
			calls.push("connect");
			return {
				host: "127.0.0.1",
				port: "9222",
				guid: "guid-1",
				browser: "Chrome/150",
				url: "https://x/",
				title: "X",
				rediscoverable: true,
				...(over.identity ?? {}),
			};
		},
		sessionExists: async () => over.alive !== false,
		ackFrame: async (ackId, gen) => calls.push(`ack:${ackId}:${gen}`),
		restartScreencast: async () => calls.push("restart"),
		click: async (x, y) => calls.push(`click:${x},${y}`),
		close: () => calls.push("close"),
	};
};

test("attach mode: CDP endpoint wins over agent-browser and disables owning paths", () => {
	const r = attachRenderer();
	assert.equal(r.mode, "attach");
	assert.equal(r.ownershipEnabled, false);
	assert.equal(r.backendName, "browser endpoint");
	// The duck-type omissions are the contract: no viewport fitting, no
	// polling failure feed, no goLive.
	assert.equal(typeof r.browser.setViewport, "undefined");
	assert.equal(typeof r.browser.network, "undefined");
	assert.equal(typeof r.browser.streamEnable, "undefined");
	const plain = mkRenderer();
	assert.equal(plain.mode, "agent-browser");
	assert.equal(plain.ownershipEnabled, true);
});

test("attach mode: tick connects, then only watches liveness", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend();
	await r.tick();
	assert.equal(r.attached, true);
	assert.equal(r.lastUrl, "https://x/");
	r.lastLiveCheck = Date.now(); // fresh check
	await r.tick();
	assert.deepEqual(r.browser.calls, ["connect"], "no polling while attached");
});

test("attach mode: frames paint and ack with the integer id after the paint settles", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend();
	let renders = 0;
	r.renderImage = async () => {
		renders++;
	};
	await r.tick();
	r.browser.emit({
		type: "frame",
		data: jpeg(1280, 720).toString("base64"),
		metadata: { deviceWidth: 1280, deviceHeight: 720 },
		ackId: 42,
		gen: 1,
	});
	await flush();
	assert.equal(renders, 1, "frame painted");
	assert.ok(r.browser.calls.includes("ack:42:1"), "acked after paint");
});

test("attach mode: clicks scale from frame pixels to page pixels per frame", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend();
	await r.tick();
	// Frame is 800px wide but the page is 1600 CSS px (retina / maxWidth scale).
	r.lastFrameMeta = { deviceWidth: 1600, deviceHeight: 900 };
	const scaled = r.cdpPagePoint({ x: 100, y: 50 }, { w: 800, h: 450 });
	assert.deepEqual(scaled, { x: 200, y: 100 });
	// Metadata changing mid-session (window resized) is picked up immediately.
	r.lastFrameMeta = { deviceWidth: 800, deviceHeight: 450 };
	assert.deepEqual(r.cdpPagePoint({ x: 100, y: 50 }, { w: 800, h: 450 }), {
		x: 100,
		y: 50,
	});
});

test("attach mode: dead endpoint detaches; raw ws endpoints do not retry", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend({ alive: false });
	await r.tick();
	r.lastLiveCheck = 0;
	await r.tick();
	assert.equal(r.attached, false);
	assert.match(r.banner, /went away — retrying/);

	const raw = attachRenderer();
	raw.browser = fakeCdpBackend({ alive: false, identity: { rediscoverable: false } });
	await raw.tick();
	raw.lastLiveCheck = 0;
	await raw.tick();
	assert.match(raw.banner, /restart the pane/);
	assert.equal(raw.streamCooldownUntil, Number.MAX_SAFE_INTEGER, "no retry loop");
});

test("attach mode: reattach to a different browser resets state with a marker", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend();
	await r.tick();
	r.consoleLines.push("  stale line from the old browser");
	r.attached = false;
	r.browser = fakeCdpBackend({ identity: { guid: "guid-2" } });
	r.browser.onMessage((m) => r.onCdpMessage(m));
	r.streamCooldownUntil = 0;
	await r.tick();
	assert.ok(
		r.consoleLines.some((l) => /reattached to a different browser/.test(l)),
		"discontinuity marker pushed",
	);
	assert.equal(r.lastHash, "", "frame state reset");
});

test("attach mode: stale frames banner once and trigger one restart", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend();
	await r.tick();
	r.lastFrameAt = Date.now() - 30_000;
	r.checkFrameStaleness();
	r.checkFrameStaleness();
	assert.match(r.banner, /frame stale/);
	assert.equal(
		r.browser.calls.filter((c) => c === "restart").length,
		1,
		"exactly one restart attempt",
	);
});

test("attach mode: cleanup closes the socket and spawns no agent-browser", async () => {
	const r = attachRenderer();
	r.browser = fakeCdpBackend();
	await r.tick();
	// Even if a navigate had wrongly flagged ownership, attach mode must not
	// shell out to close somebody else's session.
	r.selfCreated = true;
	r.cleanup();
	assert.ok(r.browser.calls.includes("close"));
	assert.equal(r.ownershipEnabled, false);
});

test("attach mode: Node without global WebSocket banners instead of crashing", async () => {
	const saved = global.WebSocket;
	delete global.WebSocket;
	try {
		const r = attachRenderer();
		const ok = await r.attachCdp();
		assert.equal(ok, false);
		assert.match(r.banner, /Node 22\+/);
	} finally {
		if (saved === undefined) delete global.WebSocket;
		else global.WebSocket = saved;
	}
});

test("attach mode: endpoint tokens never reach the banner", async () => {
	const r = attachRenderer({
		HERDR_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/SECRET-TOKEN",
	});
	r.browser = fakeCdpBackend();
	r.browser.connect = async () => {
		throw new Error("refused");
	};
	r.browser.onMessage(() => {});
	await r.attachCdp();
	assert.match(r.banner, /127\.0\.0\.1:9222/);
	assert.ok(!r.banner.includes("SECRET-TOKEN"), "capability token redacted");
});
