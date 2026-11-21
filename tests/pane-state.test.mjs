import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Renderer, sanitizeText } from "../bin/renderer.mjs";
import {
	PANE_STATE_SCHEMA_VERSION,
	buildPaneState,
	endpointHostPort,
	paneStateFile,
	readPaneState,
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
	const sh = execFileSync("bash", ["-c", `. "${repoRoot}/scripts/lib.sh" && session_name`], { env })
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
		"schemaVersion", "backend", "session", "endpoint", "attached", "url", "title",
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
	const old = process.umask(0);
	try {
		writePaneState(file, { schemaVersion: 1, pid: 1 });
	} finally {
		process.umask(old);
	}
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readPaneState(file), { schemaVersion: 1, pid: 1 });
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
		const sh = execFileSync("bash", ["-c", `. "${repoRoot}/scripts/lib.sh" && session_name`], { env, cwd })
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
