import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Renderer, deriveSession, sanitizeText } from "../bin/renderer.mjs";
import { stateDirCandidates } from "../bin/hb.mjs";
import {
	PANE_STATE_MAX_BYTES,
	PANE_STATE_SCHEMA_VERSION,
	buildPaneState,
	endpointHostPort,
	paneStateFile,
	readPaneState,
	redactUrl,
	redactUrls,
	writePaneState,
} from "../bin/pane-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HB = path.join(repoRoot, "bin", "hb.mjs");
const canCdp = typeof WebSocket === "function";

// A structurally valid 1x1 PNG: signature + IHDR + IEND (CRCs unchecked here).
const png = (w = 1) =>
	Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		(() => {
			const b = Buffer.alloc(25);
			b.writeUInt32BE(13, 0);
			b.writeUInt32BE(0x49484452, 4);
			b.writeUInt32BE(w, 8);
			b.writeUInt32BE(1, 12);
			return b;
		})(),
		(() => {
			const b = Buffer.alloc(12);
			b.writeUInt32BE(0x49454e44, 4);
			return b;
		})(),
	]);

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const mkRenderer = (over = {}) =>
	new Renderer({
		HERDR_WORKSPACE_ID: "w1",
		HERDR_PLUGIN_STATE_DIR: tmpDir("hb-ps-"),
		HOME: os.homedir(),
		PATH: "/nonexistent", // never probe or launch a real browser
		...over,
	});
const quiet = (r) => {
	r.header = () => {};
	r.renderConsole = () => {};
	r.renderBottom = () => {};
	r.renderImage = async () => {};
	r.redrawAll = async () => {};
	r.fitViewport = async () => false;
	return r;
};
// agent-browser double: every snapshot returns the current page fields.
const stubBrowser = (page) => ({
	sessionExists: async () => true,
	snapshot: async (f) => {
		fs.writeFileSync(f, page.shot ?? png());
		return { url: page.url, title: page.title, entries: page.entries ?? [] };
	},
});
const paneFileOf = (r) => path.join(r.stateDir, "pane-w1.json");
const runHb = (args, env, opts = {}) =>
	spawnSync(process.execPath, [HB, ...args], { env, encoding: "utf8", ...opts });
const hbEnv = (over = {}) => ({
	PATH: process.env.PATH,
	HOME: tmpDir("hb-home-"),
	...over,
});

// --- renderer: writing the pane file ---

test("pane state: a run-loop step writes pane-w1.json, mode 0600, schema v1", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://example.test/a", title: "A" });
	await r.step();
	const file = paneFileOf(r);
	assert.equal(r.paneFile, file);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const s = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(s.schemaVersion, 1);
	assert.equal(s.backend, "agent-browser");
	assert.equal(s.session, "herdr-ws-w1");
	assert.equal(s.endpoint, null, "agent-browser mode has no endpoint");
	assert.equal(s.attached, true);
	assert.equal(s.url, "https://example.test/a");
	assert.equal(s.title, "A");
	assert.equal(s.observeOnly, false);
	assert.deepEqual(s.consoleTail, []);
	assert.deepEqual(s.failures, []);
	assert.equal(s.pid, process.pid);
	assert.ok(!Number.isNaN(Date.parse(s.updatedAt)));
	assert.deepEqual(
		fs.readdirSync(r.stateDir).filter((f) => f.includes(".tmp")),
		[],
		"no temp file left behind",
	);
});

test("pane state: session matches bash session_name for the workspace", async () => {
	const r = quiet(mkRenderer());
	const env = { PATH: process.env.PATH, HERDR_WORKSPACE_ID: "w1" };
	const sh = execFileSync("bash", ["-c", '. "$1/scripts/lib.sh" && session_name', "bash", repoRoot], { env })
		.toString()
		.trim();
	assert.equal(r.session, sh);
	r.browser = stubBrowser({ url: "https://x/", title: "" });
	await r.step();
	assert.equal(JSON.parse(fs.readFileSync(paneFileOf(r), "utf8")).session, sh);
});

test("pane state: rewritten only when observable state changes, never per frame", async () => {
	const r = quiet(mkRenderer());
	const page = { url: "https://x/", title: "one" };
	r.browser = stubBrowser(page);
	await r.step();
	assert.equal(r.paneStateWrites, 1);
	await r.step();
	await r.step();
	assert.equal(r.paneStateWrites, 1, "unchanged state is not rewritten");
	page.shot = png(2); // a new frame alone is not an observable change
	await r.step();
	assert.equal(r.paneStateWrites, 1, "no write per frame");
	page.title = "two";
	await r.step();
	assert.equal(r.paneStateWrites, 2);
	r.observeOnly = true; // o key: not part of sig(), still published
	r.publishPaneState();
	assert.equal(r.paneStateWrites, 3);
	assert.equal(JSON.parse(fs.readFileSync(paneFileOf(r), "utf8")).observeOnly, true);
});

test("pane state: a change that arrives between ticks is published by the next step", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://x/", title: "t" });
	await r.step();
	assert.equal(r.paneStateWrites, 1);
	// An event handler (CDP Log domain, key input) changes state outside a
	// tick: the following tick sees no change of its own.
	r.pushConsole([{ text: "late line", type: "log" }], false);
	await r.step();
	assert.equal(r.paneStateWrites, 2);
	assert.deepEqual(JSON.parse(fs.readFileSync(paneFileOf(r), "utf8")).consoleTail, ["  late line"]);
	await r.step();
	assert.equal(r.paneStateWrites, 2, "published once, not again");
});

test("pane state: a failed write is retried on the next step", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://x/", title: "t" });
	r.paneFile = path.join(r.stateDir, "missing-dir", "pane-w1.json");
	await r.step();
	assert.equal(r.paneStateWrites, 0);
	r.paneFile = paneFileOf(r);
	await r.step();
	assert.equal(r.paneStateWrites, 1);
	assert.ok(fs.existsSync(paneFileOf(r)));
});

test("pane state: console tail and failures are capped at 20 and sanitized", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({
		url: "https://x/",
		title: "t\x1b]0;evil\x07",
		entries: Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}\x1b[2J`, type: "log" })),
	});
	await r.step();
	const s = JSON.parse(fs.readFileSync(paneFileOf(r), "utf8"));
	assert.equal(s.consoleTail.length, 20);
	assert.equal(s.consoleTail.at(-1), "  line 29[2J");
	assert.ok(!JSON.stringify(s).includes("\\u001b"), "no ESC in the file");
	assert.equal(s.title, "t]0;evil");
	for (let i = 0; i < 25; i++)
		r.pushLogEntry({ source: "network", text: `Failed ${i}\x1b`, url: `https://x/${i}`, level: "error" });
	r.publishPaneState();
	const s2 = JSON.parse(fs.readFileSync(paneFileOf(r), "utf8"));
	assert.equal(s2.failures.length, 20);
	assert.equal(s2.failures.at(-1), "Failed 24 https://x/24");
});

test("pane state: polled failed requests land in failures", async () => {
	const r = quiet(mkRenderer());
	r.attached = true;
	r.networkBaselinePending = false;
	r.browser = {
		network: async () => [{ requestId: "1", method: "GET", url: "https://x/api", status: 500 }],
	};
	assert.equal(await r.pollNetwork(), true);
	r.publishPaneState();
	const s = JSON.parse(fs.readFileSync(paneFileOf(r), "utf8"));
	assert.deepEqual(s.failures, ["500 GET https://x/api"]);
});

const fakeCdp = () => ({
	onMessage: () => {},
	connect: async () => ({
		host: "127.0.0.1",
		port: "9222",
		guid: "g",
		targetId: "T1",
		url: "https://cdp.test/",
		title: "CDP",
		rediscoverable: false,
	}),
	sessionExists: async () => true,
	close: () => {},
});

test("pane state: attach mode records host:port and never the token path", { skip: !canCdp }, async () => {
	const r = quiet(
		mkRenderer({ HERDR_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/SECRET-TOKEN" }),
	);
	r.browser = fakeCdp();
	await r.step();
	const raw = fs.readFileSync(paneFileOf(r), "utf8");
	const s = JSON.parse(raw);
	assert.equal(s.backend, "attach");
	assert.equal(s.session, "herdr-ws-w1");
	assert.equal(s.endpoint, "127.0.0.1:9222");
	assert.equal(s.attached, true);
	assert.equal(s.url, "https://cdp.test/");
	assert.ok(!raw.includes("/devtools/browser/"), "capability path never written");
	assert.ok(!raw.includes("SECRET-TOKEN"));
});

test("pane state: a launched Chromium is the attach backend at its loopback port", () => {
	const r = quiet(mkRenderer());
	assert.equal(r.backend, "agent-browser");
	// What launchChromium() + attachTo() leave behind (renderer internals).
	r.launchedEndpoint = "http://127.0.0.1:9333";
	r.cdpEndpoint = r.launchedEndpoint;
	r.backend = "attach";
	r.publishPaneState();
	const s = JSON.parse(fs.readFileSync(paneFileOf(r), "utf8"));
	assert.equal(s.backend, "attach");
	assert.equal(s.endpoint, "127.0.0.1:9333");
	assert.equal(s.session, "herdr-ws-w1", "the session name is kept for agent-browser connect");
});

test("pane state: cleanup removes the pane file", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://x/", title: "" });
	await r.step();
	assert.ok(fs.existsSync(paneFileOf(r)));
	r.cleanup();
	assert.equal(fs.existsSync(paneFileOf(r)), false);
});

// --- pure module ---

test("endpointHostPort keeps host:port only and fills CDP's default port", () => {
	assert.equal(endpointHostPort("ws://127.0.0.1:9222/devtools/browser/abc"), "127.0.0.1:9222");
	assert.equal(endpointHostPort("http://localhost:9333"), "localhost:9333");
	assert.equal(endpointHostPort("http://[::1]:9222/"), "[::1]:9222");
	assert.equal(endpointHostPort("http://127.0.0.1"), "127.0.0.1:9222");
	assert.equal(endpointHostPort("wss://remote.test/cdp?token=x"), "remote.test:443");
	assert.equal(endpointHostPort("http://user:pw@h:1/"), "h:1", "userinfo dropped");
	assert.equal(endpointHostPort("not a url"), null);
	assert.equal(endpointHostPort("file:///etc/passwd"), null);
	assert.equal(endpointHostPort(null), null);
});

test("buildPaneState shapes, caps, and sanitizes every field", () => {
	const s = buildPaneState(
		{
			backend: "attach",
			session: "s",
			endpoint: "ws://h:1/devtools/browser/x",
			attached: 1,
			url: "https://x/\x1b",
			title: undefined,
			observeOnly: 0,
			consoleLines: Array.from({ length: 25 }, (_, i) => `c${i}`),
			failures: ["f\x07"],
			pid: 42,
			now: new Date("2026-01-01T00:00:00Z"),
		},
		sanitizeText,
	);
	assert.deepEqual(Object.keys(s), [
		"schemaVersion", "backend", "session", "endpoint", "endpointDiscoverable", "attached", "url", "title",
		"observeOnly", "consoleTail", "failures", "updatedAt", "pid",
	]);
	assert.equal(s.schemaVersion, PANE_STATE_SCHEMA_VERSION);
	assert.equal(s.endpoint, "h:1");
	assert.equal(s.attached, true);
	assert.equal(s.observeOnly, false);
	assert.equal(s.url, "https://x/");
	assert.equal(s.title, "");
	assert.equal(s.consoleTail.length, 20);
	assert.equal(s.consoleTail[0], "c5");
	assert.deepEqual(s.failures, ["f"]);
	assert.equal(s.updatedAt, "2026-01-01T00:00:00.000Z");
	const ab = buildPaneState({ backend: "agent-browser", endpoint: "http://h:1", pid: 1 }, sanitizeText);
	assert.equal(ab.endpoint, null, "agent-browser mode never records an endpoint");
});

test("writePaneState is atomic and private even under a permissive umask", () => {
	const dir = tmpDir("hb-w-");
	const file = paneStateFile(dir, "w1");
	assert.equal(file, path.join(dir, "pane-w1.json"));
	const state = buildPaneState({ session: "s", pid: 1 }, sanitizeText);
	const old = process.umask(0);
	try {
		writePaneState(file, state);
	} finally {
		process.umask(old);
	}
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readPaneState(file), state);
	assert.deepEqual(fs.readdirSync(dir), ["pane-w1.json"]);
	assert.equal(readPaneState(path.join(dir, "missing.json")), null);
});

// --- hb CLI ---

test("hb status --json prints the pane file the renderer wrote, exit 0", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://x/", title: "X" });
	await r.step();
	const res = runHb(["status", "--json"], hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: r.stateDir }));
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(JSON.parse(res.stdout), JSON.parse(fs.readFileSync(paneFileOf(r), "utf8")));
	const text = runHb(["status"], hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: r.stateDir }));
	assert.equal(text.status, 0);
	assert.match(text.stdout, /url: +https:\/\/x\//);
	assert.match(text.stdout, /session: +herdr-ws-w1/);
});

test("hb status: no pane file -> no-pane, exit 3", () => {
	const res = runHb(["status", "--json"], hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: tmpDir("hb-np-") }));
	assert.equal(res.status, 3);
	assert.deepEqual(JSON.parse(res.stdout), { status: "no-pane" });
	const text = runHb(["status"], hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: tmpDir("hb-np-") }));
	assert.equal(text.status, 3);
	assert.match(text.stdout, /no browser pane/);
});

test("hb status: a dead recorded pid -> no-pane, exit 3", () => {
	const dir = tmpDir("hb-stale-");
	const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	const pid = Number(dead.stdout);
	writePaneState(paneStateFile(dir, "w1"), buildPaneState({ backend: "agent-browser", session: "s", pid }, sanitizeText));
	const res = runHb(["status", "--json"], hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: dir }));
	assert.equal(res.status, 3);
	assert.deepEqual(JSON.parse(res.stdout), { status: "no-pane" });
});

test("hb status: a corrupt pane file is an error, exit 1", () => {
	const dir = tmpDir("hb-bad-");
	fs.writeFileSync(paneStateFile(dir, "w1"), "{not json", { mode: 0o600 });
	const res = runHb(["status", "--json"], hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: dir }));
	assert.equal(res.status, 1);
	assert.equal(JSON.parse(res.stdout).status, "error");
});

test("hb finds the pane under herdr's per-plugin state dir when the env var is unset", () => {
	const home = tmpDir("hb-home-");
	const dir = path.join(home, ".local/state/herdr/plugins/structupath.browser");
	fs.mkdirSync(dir, { recursive: true });
	const state = buildPaneState({ backend: "agent-browser", session: "herdr-ws-w1", pid: process.pid }, sanitizeText);
	writePaneState(paneStateFile(dir, "w1"), state);
	const res = runHb(["status", "--json"], { PATH: process.env.PATH, HOME: home, HERDR_WORKSPACE_ID: "w1" });
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(JSON.parse(res.stdout), state);
	const xdg = tmpDir("hb-xdg-");
	const xdir = path.join(xdg, "herdr/plugins/structupath.browser");
	fs.mkdirSync(xdir, { recursive: true });
	writePaneState(paneStateFile(xdir, "w2"), { ...state, session: "herdr-ws-w2" });
	const x = runHb(["status", "--json"], { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: xdg, HERDR_WORKSPACE_ID: "w2" });
	assert.equal(x.status, 0, x.stderr);
	assert.equal(JSON.parse(x.stdout).session, "herdr-ws-w2");
});

test("hb session matches bash session_name across env/config/workspace/cwd", () => {
	const cfg = tmpDir("hb-cfg-");
	fs.writeFileSync(path.join(cfg, "session"), "cfg session\n");
	const emptyCfg = tmpDir("hb-cfg-empty-");
	fs.writeFileSync(path.join(emptyCfg, "session"), "\n");
	const cwd = fs.realpathSync(tmpDir("hb-cwd-"));
	const cases = [
		{ HERDR_BROWSER_SESSION: "over\x1bride", HERDR_WORKSPACE_ID: "w1" },
		{ HERDR_BROWSER_SESSION: " \t", HERDR_WORKSPACE_ID: "w1" },
		{ HERDR_PLUGIN_CONFIG_DIR: cfg, HERDR_WORKSPACE_ID: "w1" },
		{ HERDR_PLUGIN_CONFIG_DIR: emptyCfg, HERDR_WORKSPACE_ID: "w/../1" },
		{ HERDR_WORKSPACE_ID: "w1" },
		{},
	];
	for (const over of cases) {
		const env = { PATH: process.env.PATH, HOME: tmpDir("hb-home-"), HERDR_PLUGIN_STATE_DIR: tmpDir("hb-st-"), ...over };
		const sh = execFileSync("bash", ["-c", '. "$1/scripts/lib.sh" && session_name', "bash", repoRoot], { env, cwd })
			.toString()
			.trim();
		const text = runHb(["session"], env, { cwd });
		assert.equal(text.status, 0, text.stderr);
		assert.equal(text.stdout.split("\n")[0], `session: ${sh}`, JSON.stringify(over));
		const json = runHb(["session", "--json"], env, { cwd });
		assert.equal(json.status, 0);
		assert.deepEqual(JSON.parse(json.stdout), {
			session: sh,
			source: "derived",
			backend: null,
			endpoint: null,
			endpointDiscoverable: null,
		});
	}
});

test("hb session reports the live pane's session and attach endpoint", () => {
	const dir = tmpDir("hb-sess-");
	writePaneState(
		paneStateFile(dir, "w1"),
		buildPaneState(
			{ backend: "attach", session: "pane-session", endpoint: "ws://127.0.0.1:9222/devtools/browser/T", attached: true, pid: process.pid },
			sanitizeText,
		),
	);
	const env = hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: dir });
	const json = runHb(["session", "--json"], env);
	assert.equal(json.status, 0, json.stderr);
	assert.deepEqual(JSON.parse(json.stdout), {
		session: "pane-session",
		source: "pane",
		backend: "attach",
		endpoint: "127.0.0.1:9222",
		endpointDiscoverable: true, // Chrome's own /devtools/browser/ URL shares the discovery port
	});
	const text = runHb(["session"], env);
	assert.match(text.stdout, /^session: pane-session\nendpoint: 127\.0\.0\.1:9222\n/);
	assert.match(text.stdout, /agent-browser --session pane-session connect http:\/\/127\.0\.0\.1:9222/);
	assert.ok(!text.stdout.includes("/devtools/browser/"));
});

test("hb help and usage errors use stable exit codes", () => {
	const env = hbEnv({ HERDR_PLUGIN_STATE_DIR: tmpDir("hb-h-") });
	for (const args of [["help"], ["--help"], []]) {
		const res = runHb(args, env);
		assert.equal(res.status, 0, args.join(" "));
		assert.match(res.stdout, /Exit codes/);
	}
	const bad = runHb(["frobnicate"], env);
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /unknown command/);
	const badFlag = runHb(["status", "--yaml"], env);
	assert.equal(badFlag.status, 2);
});

// --- review fixes ---

const SECRET_URL =
	"https://synthetic-user:synthetic-pass@example.test/private?token=SYNTHETIC-QUERY#SYNTHETIC-FRAGMENT";

test("pane state: URL credentials, query, and fragment never reach the file", () => {
	const r = quiet(mkRenderer());
	r.lastUrl = SECRET_URL;
	r.pushLogEntry({ source: "network", text: "Failed", url: SECRET_URL, level: "error" });
	r.pushConsole([{ text: "ws wss://u:p@h.test:1/x?SYNTHETIC-QUERY=1 done", type: "log" }], false);
	r.publishPaneState();
	const raw = fs.readFileSync(paneFileOf(r), "utf8");
	for (const s of ["synthetic-user", "synthetic-pass", "SYNTHETIC-QUERY", "SYNTHETIC-FRAGMENT", "u:p@"])
		assert.ok(!raw.includes(s), `${s} persisted`);
	const s = JSON.parse(raw);
	assert.equal(s.url, "https://example.test/private");
	// Free text with userinfo loses the whole URL; the page URL field parses one.
	assert.deepEqual(s.failures, ["Failed [redacted URL]"]);
	assert.ok(s.consoleTail.includes("  ws [redacted URL] done"), JSON.stringify(s.consoleTail));
});

test("redactUrls strips userinfo, query, and hash from every URL in text", () => {
	assert.equal(
		redactUrls("a http://u:p@h/x?q=1#f b ws://h:9/d?t=2 c HTTPS://H/ok"),
		"a [redacted URL] b ws://h:9/d c HTTPS://H/ok",
	);
	assert.equal(redactUrls("no url here"), "no url here");
	assert.equal(redactUrls("xhttps://u:p@h/?q"), "x[redacted URL]", "a URL glued to a word");
	assert.equal(redactUrls("trunc https://h/p?tok…"), "trunc https://h/p…");
	assert.equal(redactUrl(SECRET_URL), "https://example.test/private");
	assert.equal(redactUrl("about:blank"), "about:blank");
	assert.equal(redactUrl(""), "");
	assert.equal(redactUrl("file:///a?b#c"), "file:///a");
});

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("pane state: every string and the whole file are bounded", () => {
	const r = quiet(mkRenderer());
	const big = "X".repeat(256 * 1024);
	r.lastTitle = `a${"😀".repeat(2000)}`; // the 2,000-unit cut lands inside a pair
	r.lastUrl = `https://example.test/${big}`;
	r.consoleLines = Array.from({ length: 20 }, (_, i) => `c${i} ${"€".repeat(1000)}`);
	r.failedRequests = Array.from({ length: 20 }, (_, i) => `f${i} ${"€".repeat(1000)}`);
	r.publishPaneState();
	const file = paneFileOf(r);
	assert.ok(fs.statSync(file).size <= PANE_STATE_MAX_BYTES, `file is ${fs.statSync(file).size} bytes`);
	const s = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.ok(s.title.length <= 2000 && s.url.length <= 2000);
	assert.ok(!loneSurrogate.test(s.title), "surrogate pair split");
	for (const l of [...s.consoleTail, ...s.failures]) assert.ok(l.length <= 500, `line ${l.length}`);
	assert.ok(s.consoleTail.length + s.failures.length < 40, "oldest lines dropped to fit");
	assert.ok(s.consoleTail.at(-1).trimStart().startsWith("c19"), "newest console line kept");
	assert.ok(s.failures.at(-1).startsWith("f19"), "newest failure kept");
});

test("writePaneState never follows a symlink and creates its temp file exclusively at 0600", () => {
	const dir = tmpDir("hb-sym-");
	const victim = path.join(dir, "victim.txt");
	const file = paneStateFile(dir, "w1");
	fs.writeFileSync(victim, "DO NOT REPLACE", { mode: 0o644 });
	fs.symlinkSync(victim, `${file}.${process.pid}.tmp`); // the old predictable name
	const state = buildPaneState({ session: "s", pid: process.pid }, sanitizeText);
	writePaneState(file, state);
	assert.equal(fs.readFileSync(victim, "utf8"), "DO NOT REPLACE");
	// A symlink planted at the exact temp name between naming and open: the
	// exclusive create must refuse it, and the planted link must survive.
	const realOpen = fs.openSync;
	let planted = null;
	let modeAtOpen = null;
	fs.openSync = function (p, ...rest) {
		if (String(p).startsWith(`${file}.`) && planted === null) {
			planted = String(p);
			fs.symlinkSync(victim, planted);
		}
		return realOpen.call(this, p, ...rest);
	};
	try {
		assert.throws(() => writePaneState(file, state), { code: "EEXIST" });
	} finally {
		fs.openSync = realOpen;
	}
	assert.ok(planted, "the temp file is created with fs.openSync");
	assert.equal(fs.readFileSync(victim, "utf8"), "DO NOT REPLACE");
	assert.ok(fs.lstatSync(planted).isSymbolicLink(), "someone else's file is not unlinked");
	// The temp file is 0600 from creation, even under a permissive umask.
	fs.openSync = function (p, ...rest) {
		const fd = realOpen.call(this, p, ...rest);
		if (String(p).startsWith(`${file}.`)) modeAtOpen = fs.fstatSync(fd).mode & 0o777;
		return fd;
	};
	const old = process.umask(0);
	try {
		writePaneState(file, state);
	} finally {
		process.umask(old);
		fs.openSync = realOpen;
	}
	assert.equal(modeAtOpen, 0o600);
	assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
});

test("pane state: a failed observe-only publish is retried by the next idle step", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://x/", title: "t" });
	await r.step();
	r.paneFile = path.join(r.stateDir, "missing-dir", "pane-w1.json");
	r.toggleObserveOnly(); // the write fails
	r.paneFile = paneFileOf(r);
	await r.step(); // nothing in sig() moved
	assert.equal(JSON.parse(fs.readFileSync(paneFileOf(r), "utf8")).observeOnly, true);
});

test("pane state: cleanup leaves a pane file that another process now owns", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://x/", title: "" });
	await r.step();
	const other = buildPaneState({ session: "newer", pid: process.pid + 1 }, sanitizeText);
	writePaneState(paneFileOf(r), other); // a newer pane for the same workspace
	r.cleanup();
	assert.deepEqual(readPaneState(paneFileOf(r)), other);
});

test("hb without HERDR_WORKSPACE_ID accepts only a pane whose session is the caller's", () => {
	const dir = tmpDir("hb-nows-");
	const cwd = fs.realpathSync(tmpDir("hb-cwd-"));
	const env = hbEnv({ HERDR_PLUGIN_STATE_DIR: dir });
	const mine = deriveSession(env, cwd);
	const file = paneStateFile(dir, "default");
	writePaneState(file, buildPaneState({ session: "herdr-cwd-1", pid: process.pid }, sanitizeText));
	const st = runHb(["status", "--json"], env, { cwd });
	assert.equal(st.status, 3, st.stdout);
	assert.deepEqual(JSON.parse(st.stdout), { status: "no-pane" });
	const se = runHb(["session", "--json"], env, { cwd });
	assert.deepEqual(JSON.parse(se.stdout), { session: mine, source: "derived", backend: null, endpoint: null, endpointDiscoverable: null });
	writePaneState(file, buildPaneState({ session: mine, pid: process.pid }, sanitizeText));
	const ok = runHb(["status", "--json"], env, { cwd });
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(ok.stdout).session, mine);
});

test("hb prefers the matching session when several state dirs hold a live pane", () => {
	const home = tmpDir("hb-home-");
	const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: tmpDir("hb-xdg-"), HERDR_WORKSPACE_ID: "w1" };
	const dirs = stateDirCandidates(env);
	assert.equal(dirs.length, 3);
	dirs.forEach((d, i) => {
		fs.mkdirSync(d, { recursive: true });
		const session = i === 2 ? "herdr-ws-w1" : `candidate-${i}`;
		writePaneState(paneStateFile(d, "w1"), buildPaneState({ session, pid: process.pid }, sanitizeText));
	});
	const res = runHb(["session", "--json"], env);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(JSON.parse(res.stdout).session, "herdr-ws-w1");
	assert.equal(res.stderr, "");
	// No candidate matches: the choice is reported, not silent.
	writePaneState(paneStateFile(dirs[2], "w1"), buildPaneState({ session: "candidate-2", pid: process.pid }, sanitizeText));
	const amb = runHb(["status", "--json"], env);
	assert.equal(amb.status, 0);
	assert.equal(JSON.parse(amb.stdout).session, "candidate-0");
	assert.match(amb.stderr, /several live pane files/);
	assert.ok(amb.stderr.includes(dirs[1]));
});

test("hb status: a pane file that is not schema v1 is an error, exit 1", () => {
	const dir = tmpDir("hb-schema-");
	const file = paneStateFile(dir, "w1");
	const env = hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: dir });
	const good = buildPaneState({ session: "s", pid: process.pid }, sanitizeText);
	for (const bad of [
		{},
		{ pid: process.pid, unexpected: "not pane schema" },
		{ ...good, schemaVersion: 2 },
		{ ...good, consoleTail: [1] },
		{ ...good, attached: "yes" },
		[],
	]) {
		fs.writeFileSync(file, JSON.stringify(bad), { mode: 0o600 });
		const res = runHb(["status", "--json"], env);
		assert.equal(res.status, 1, JSON.stringify(bad));
		assert.equal(JSON.parse(res.stdout).status, "error");
	}
});

test("hb runs when invoked through a symlink", () => {
	const link = path.join(tmpDir("hb-link-"), "hb");
	fs.symlinkSync(HB, link);
	const res = spawnSync(process.execPath, [link, "help"], { encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /Exit codes/);
});

test("redactUrls: quotes, brackets, and non-web schemes never keep a secret", () => {
	const cases = [
		["https://h/p?token='TOKEN'#FRAG", "https://h/p"],
		["https://user:P'ASS@example.test/p?token=TOKEN", "[redacted URL]"],
		["see (https://user:pw@x.test/p).", "see ([redacted URL]"],
		["file:///etc/x?secret=1#f", "file:///etc/x"],
		["load data:text/plain,SECRET done", "load data:[redacted] done"],
		["blob:https://user:PASS@example.test/id", "[redacted URL]"],
		["http://[::1]:9222/json?t=1", "http://[::1]:9222/json"],
		["metadata: ok", "metadata: ok"],
		// From the first "?" to the end of the word goes, delimiters and all.
		["failure(https://example.test/p?token=')SECRET);retry=false", "failure(https://example.test/p"],
	];
	for (const [input, want] of cases) assert.equal(redactUrls(input), want, input);
	for (const [, got] of cases.map(([i]) => [i, redactUrls(i)]))
		assert.doesNotMatch(got, /TOKEN|FRAG|SECRET|PASS|P'ASS|user|secret=|pw@|t=1/);
	assert.equal(redactUrl("blob:https://user:PASS@example.test/id"), "blob:https://example.test/id");
	assert.equal(redactUrl("data:text/html,<b>SECRET</b>"), "data:[redacted]");
	assert.equal(redactUrl("not a url"), "[unavailable URL]");
});

test("pane state: an oversized endpoint is capped with the other fields", () => {
	const state = buildPaneState({ backend: "attach", endpoint: `http://${"a".repeat(70_000)}.test:9222`, pid: 1 }, (s) => s);
	assert.ok(state.endpoint.length <= 2000);
	assert.ok(Buffer.byteLength(JSON.stringify(state, null, 2)) <= PANE_STATE_MAX_BYTES);
});

test("pane state: a file that vanishes is written again on the next idle step", async () => {
	const r = quiet(mkRenderer());
	r.browser = stubBrowser({ url: "https://example.test/a", title: "A" });
	await r.step();
	const file = paneFileOf(r);
	assert.ok(fs.existsSync(file));
	fs.unlinkSync(file); // an older pane's cleanup raced this pane's write
	await r.step(); // nothing observable changed
	assert.ok(fs.existsSync(file), "the live pane restores its file without a state change");
});

test("redactUrls: <, >, and a literal … inside a URL never shield a secret", () => {
	const cases = [
		["load data:text/html,<b>SECRET</b> done", "load data:[redacted] done"],
		["see https://h/?a…token=SECRET end", "see https://h/ end"],
		["<https://u:p@x.test/p>", "<[redacted URL]"],
		["cut https://h/path…", "cut https://h/path…"], // truncate()'s own marker stays
		["cut https://h/p?token=SEC…", "cut https://h/p…"],
		// No "@", "?", or "#": nothing to strip, so the glued text is kept as is.
		["request <https://example.com>net::ERR_CONNECTION_REFUSED", "request <https://example.com>net::ERR_CONNECTION_REFUSED"],
		["<https://a.test/x>https://u:p@b.test/y?t=SEC", "<[redacted URL]"],
		["get https://h/?q=<b>SECRET done", "get https://h/ done"],
		// Userinfo needs an "@"; any "@" withholds the URL, however it is spelled.
		["https://user:pw<SECRET@example.test/p?token=QUERY#FRAGMENT", "[redacted URL]"],
		["https://user:pw>SECRET@example.test/p?token=QUERY#FRAGMENT", "[redacted URL]"],
		["https://user:pw…<SECRET@example.test/p", "[redacted URL]"],
		["<https://user:pw>SECRET@example.test/p>", "<[redacted URL]"],
		["https:///user:pw<SECRET@example.test/p?token=QUERY#FRAGMENT", "[redacted URL]"],
		["https:////user:pw@example.test/p", "[redacted URL]"],
		["request <https://user:pw<SECRET@example.test>net::ERR", "request <[redacted URL]"],
		["HTTPS://U:P@X.TEST/a?T=QUERY", "[redacted URL]"],
	];
	for (const [input, want] of cases) assert.equal(redactUrls(input), want, input);
	for (const [input] of cases) assert.doesNotMatch(redactUrls(input), /SECRET|SEC|u:p@|pw|QUERY|FRAGMENT/);
});

test("pane state: endpointDiscoverable says whether host:port alone reaches the browser", () => {
	const s = (endpoint, backend = "attach") => buildPaneState({ backend, endpoint, pid: 1 }, (x) => x);
	assert.equal(s("http://127.0.0.1:9222").endpointDiscoverable, true);
	assert.equal(s("ws://127.0.0.1:9222/devtools/browser/abc").endpointDiscoverable, true, "Chrome's own endpoint");
	assert.equal(s("ws://127.0.0.1:3000/5f2c9a").endpointDiscoverable, false, "a Playwright server");
	assert.equal(s("wss://cloud.test/?token=TOKEN").endpointDiscoverable, false, "a hosted browser");
	assert.equal(s("ws://proxy.test:8080/cdp/browser/TOKEN").endpointDiscoverable, false, "a proxy");
	assert.doesNotMatch(JSON.stringify(s("ws://proxy.test:8080/cdp/browser/TOKEN")), /TOKEN/);
	assert.equal(s(null, "agent-browser").endpointDiscoverable, null);
});

test("hb session only suggests connect for an endpoint that answers discovery", () => {
	const env = hbEnv({ HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_STATE_DIR: tmpDir("hb-st-") });
	const file = paneStateFile(env.HERDR_PLUGIN_STATE_DIR, "w1");
	const write = (endpoint) => writePaneState(file, buildPaneState({ backend: "attach", session: "herdr-ws-w1", endpoint, pid: process.pid }, sanitizeText));
	write("ws://proxy.test:8080/cdp/browser/TOKEN");
	let out = runHb(["session"], env).stdout;
	assert.doesNotMatch(out, /connect http:/);
	assert.match(out, /ask for the full URL/);
	assert.doesNotMatch(out, /TOKEN/);
	write("http://127.0.0.1:9222");
	out = runHb(["session"], env).stdout;
	assert.match(out, /connect http:\/\/127\.0\.0\.1:9222/);
	assert.equal(JSON.parse(runHb(["session", "--json"], env).stdout).endpointDiscoverable, true);
});

test("readPaneState accepts a v1 file from a writer that predates endpointDiscoverable", () => {
	const file = path.join(tmpDir("hb-old-"), "pane-w1.json");
	const state = buildPaneState({ backend: "attach", session: "s", endpoint: "http://127.0.0.1:9222", pid: process.pid }, sanitizeText);
	delete state.endpointDiscoverable;
	writePaneState(file, state);
	assert.equal(readPaneState(file).endpoint, "127.0.0.1:9222");
});

test("redactUrls: no generated URL keeps a userinfo, query, or fragment secret", () => {
	// Seeded, so a failure reproduces. Secrets sit only where a URL can carry
	// them; everything around them is drawn from characters that confused the
	// earlier boundary guessing.
	let seed = 0x5eed;
	// Math.imul keeps the LCG exact (a plain * overflows 2^53 and zeroes the
	// low bits); the high bits are the well-mixed ones.
	const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;
	const pick = (xs) => xs[rnd(xs.length)];
	const junk = () => Array.from({ length: rnd(4) }, () => pick(["<", ">", "…", "'", '"', ")", "(", ";", "/", "[", "]", ":", "x"])).join("");
	let withUserinfo = 0;
	let withQuery = 0;
	for (let i = 0; i < 5_000; i++) {
		const scheme = pick(["http://", "https://", "ws://", "wss://", "HTTPS://", "https:///", "https:////", "blob:https://", "file://"]);
		const userinfo = rnd(2) ? `u${junk()}:pw${junk()}SECRETU${junk()}@` : "";
		const host = pick(["example.test", "[::1]", "127.0.0.1:9222", "h"]);
		const query = rnd(2) ? `?${junk()}t=${junk()}SECRETQ${junk()}` : "";
		const frag = rnd(2) ? `#${junk()}SECRETF` : "";
		const word = `${junk()}${scheme}${userinfo}${host}/${junk()}p${query}${frag}${junk()}`;
		if (userinfo) withUserinfo++;
		if (query) withQuery++;
		const out = redactUrls(`before ${word} after`);
		assert.doesNotMatch(out, /SECRET[UQF]/, `${word} -> ${out}`);
		assert.ok(out.startsWith("before ") && out.endsWith(" after"), out);
	}
	// The generator really produced the shapes it claims to test.
	assert.ok(withUserinfo > 2_000 && withQuery > 2_000, `${withUserinfo} userinfo, ${withQuery} query cases`);
});
