import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
	cdpSupported,
	redactWsUrl,
	discoverEndpoint,
	makeCdpSession,
} from "../bin/cdp.mjs";

// --- discovery ---

const withStubEndpoint = async (fn, { host = "127.0.0.1" } = {}) => {
	const seen = { hosts: [] };
	const server = http.createServer((req, res) => {
		seen.hosts.push(req.headers.host);
		if (req.url === "/json/version") {
			res.end(
				JSON.stringify({
					Browser: "Chrome/150.0.0.0",
					webSocketDebuggerUrl: `ws://${host}:${server.address().port}/devtools/browser/abc-123`,
				}),
			);
		} else if (req.url === "/json/list") {
			res.end(
				JSON.stringify([
					{ type: "page", id: "P1", url: "https://x/" },
					{ type: "service_worker", id: "W1", url: "https://x/sw.js" },
				]),
			);
		} else {
			res.statusCode = 404;
			res.end("nope");
		}
	});
	await new Promise((r) => server.listen(0, host, r));
	try {
		await fn(server.address().port, seen);
	} finally {
		server.close();
	}
};

test("discoverEndpoint resolves /json/version and filters page targets", async () => {
	await withStubEndpoint(async (port) => {
		const ep = await discoverEndpoint(`http://127.0.0.1:${port}`);
		assert.equal(ep.browser, "Chrome/150.0.0.0");
		assert.match(ep.wsUrl, /^ws:\/\/127\.0\.0\.1/);
		assert.equal(ep.guid, "abc-123");
		assert.deepEqual(
			ep.pages.map((p) => p.id),
			["P1"],
			"non-page targets filtered",
		);
		assert.equal(ep.rediscoverable, true);
	});
});

test("discoverEndpoint sends an IP-literal Host for DNS-name input", async () => {
	await withStubEndpoint(async (port, seen) => {
		const ep = await discoverEndpoint(`http://devbox.local:${port}`, {
			lookup: async () => ({ address: "127.0.0.1" }),
		});
		assert.ok(ep.wsUrl);
		assert.ok(
			seen.hosts.every((h) => h.startsWith("127.0.0.1:")),
			`Host headers must be IP literals, saw ${seen.hosts}`,
		);
	});
});

test("discoverEndpoint refuses page-level URLs with a pointer to the browser endpoint", async () => {
	await assert.rejects(
		discoverEndpoint("ws://127.0.0.1:9222/devtools/page/DEADBEEF"),
		/browser endpoint/,
	);
});

test("discoverEndpoint passes raw browser ws URLs through, marked non-rediscoverable", async () => {
	const ep = await discoverEndpoint("ws://127.0.0.1:9222/devtools/browser/xyz");
	assert.equal(ep.rediscoverable, false);
	assert.equal(ep.guid, "xyz");
	assert.equal(ep.browser, null);
});

test("discoverEndpoint rejects junk and non-endpoint schemes", async () => {
	await assert.rejects(discoverEndpoint("not a url"), /endpoint URL/);
	await assert.rejects(discoverEndpoint("file:///etc/passwd"), /endpoint URL/);
});

test("redactWsUrl strips capability token paths everywhere", () => {
	assert.equal(
		redactWsUrl("ws://127.0.0.1:9222/devtools/browser/secret-guid-here"),
		"127.0.0.1:9222",
	);
	assert.equal(redactWsUrl("total junk"), "invalid endpoint");
});

test("cdpSupported reflects the global WebSocket gate", () => {
	assert.equal(cdpSupported(), typeof WebSocket === "function");
});

// --- session layer (fake ws seam, no network) ---

const makeFakeWs = () => {
	const sent = [];
	const ws = {
		sent,
		onopen: null,
		onclose: null,
		onerror: null,
		onmessage: null,
		send: (s) => sent.push(JSON.parse(s)),
		close() {
			this.onclose?.();
		},
		// test drivers
		open: () => ws.onopen?.(),
		deliver: (obj) => ws.onmessage?.({ data: JSON.stringify(obj) }),
	};
	return ws;
};

test("session correlates concurrent requests and routes errors", async () => {
	const ws = makeFakeWs();
	const s = makeCdpSession("ws://x/devtools/browser/1", { wsFactory: () => ws });
	ws.open();
	await s.opened;
	const a = s.send("Page.enable", {}, "S1");
	const b = s.send("Page.navigate", { url: "https://x/" }, "S1");
	assert.equal(ws.sent.length, 2);
	assert.equal(ws.sent[1].sessionId, "S1");
	ws.deliver({ id: ws.sent[1].id, result: { frameId: "F" } });
	ws.deliver({ id: ws.sent[0].id, error: { message: "nope" } });
	assert.deepEqual(await b, { frameId: "F" });
	await assert.rejects(a, /nope/);
});

test("session events fan out and a throwing subscriber cannot break others", async () => {
	const ws = makeFakeWs();
	const s = makeCdpSession("ws://x/devtools/browser/1", { wsFactory: () => ws });
	ws.open();
	await s.opened;
	const got = [];
	s.onEvent(() => {
		throw new Error("bad subscriber");
	});
	s.onEvent((m) => got.push(m.method));
	ws.deliver({ method: "Page.screencastFrame", params: {}, sessionId: "S1" });
	assert.deepEqual(got, ["Page.screencastFrame"]);
});

test("close fails pending requests and fires onClose once", async () => {
	const ws = makeFakeWs();
	const s = makeCdpSession("ws://x/devtools/browser/1", { wsFactory: () => ws });
	ws.open();
	await s.opened;
	let closes = 0;
	s.onClose(() => closes++);
	const p = s.send("Browser.getVersion");
	ws.close();
	await assert.rejects(p, /connection closed/);
	assert.equal(closes, 1);
	assert.equal(s.dead, true);
	await assert.rejects(s.send("Page.enable"), /connection closed/);
});

test("ping resolves false on timeout instead of throwing", async () => {
	const ws = makeFakeWs();
	const s = makeCdpSession("ws://x/devtools/browser/1", { wsFactory: () => ws });
	ws.open();
	await s.opened;
	assert.equal(await s.ping(50), false, "no reply -> dead");
	const alive = s.ping(1000);
	ws.deliver({ id: ws.sent.at(-1).id, result: { product: "Chrome" } });
	assert.equal(await alive, true);
});

test("malformed frames are dropped without throwing", async () => {
	const ws = makeFakeWs();
	const s = makeCdpSession("ws://x/devtools/browser/1", { wsFactory: () => ws });
	ws.open();
	await s.opened;
	ws.onmessage({ data: "%%% not json %%%" });
	const p = s.send("Page.enable");
	ws.deliver({ id: ws.sent.at(-1).id, result: {} });
	await p; // session still functional
});

// --- makeCdpBrowser adapter (scripted fake CDP endpoint, no network) ---

import { makeCdpBrowser } from "../bin/cdp.mjs";

const makeFakeCdp = ({ pages, results } = {}) => {
	const state = {
		sent: [],
		pages: pages ?? [
			{ targetId: "T1", type: "page", url: "https://x/", title: "X" },
		],
		results: results ?? {},
		ws: null,
	};
	const ws = {
		onopen: null,
		onclose: null,
		onerror: null,
		onmessage: null,
		send(s) {
			const msg = JSON.parse(s);
			state.sent.push(msg);
			const custom = state.results[msg.method];
			const result =
				typeof custom === "function"
					? custom(msg)
					: custom !== undefined
						? custom
						: msg.method === "Target.getTargets"
							? { targetInfos: state.pages }
							: msg.method === "Target.attachToTarget"
								? { sessionId: `sess-${msg.params.targetId}` }
								: {};
			if (result !== null)
				queueMicrotask(() =>
					ws.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }),
				);
		},
		close() {
			this.onclose?.();
		},
	};
	state.ws = ws;
	state.deliver = (obj) => ws.onmessage?.({ data: JSON.stringify(obj) });
	state.calls = (method) => state.sent.filter((m) => m.method === method);
	return state;
};

const attachBrowser = async (fake) => {
	const b = makeCdpBrowser("ws://127.0.0.1:1/devtools/browser/test", {
		wsFactory: () => {
			queueMicrotask(() => fake.ws.onopen?.());
			return fake.ws;
		},
	});
	const got = [];
	b.onMessage((m) => got.push(m));
	const id = await b.connect();
	return { b, got, id };
};

test("adapter surface: forbidden methods are absent, required ones present", async () => {
	const fake = makeFakeCdp();
	const { b } = await attachBrowser(fake);
	for (const missing of ["setViewport", "network", "snapshot", "streamEnable", "streamStatus"])
		assert.equal(b[missing], undefined, `${missing} must not exist — duck-type guards depend on it`);
	for (const required of ["open", "back", "forward", "reload", "click", "scroll", "type", "sessionExists", "screenshot", "cycleTarget"])
		assert.equal(typeof b[required], "function", `${required} missing — a key handler calls it unguarded`);
});

test("adapter pins the first page target and starts a jpeg screencast", async () => {
	const fake = makeFakeCdp({
		pages: [
			{ targetId: "T1", type: "page", url: "https://one/", title: "One" },
			{ targetId: "T2", type: "page", url: "https://two/", title: "Two" },
		],
	});
	const { id } = await attachBrowser(fake);
	assert.equal(id.url, "https://one/");
	const att = fake.calls("Target.attachToTarget");
	assert.equal(att.length, 1);
	assert.deepEqual(att[0].params, { targetId: "T1", flatten: true });
	const sc = fake.calls("Page.startScreencast")[0];
	assert.equal(sc.params.format, "jpeg");
	assert.equal(sc.sessionId, "sess-T1");
});

test("adapter never creates or closes targets across its whole lifecycle", async () => {
	const fake = makeFakeCdp({
		pages: [
			{ targetId: "T1", type: "page", url: "https://one/", title: "One" },
			{ targetId: "T2", type: "page", url: "https://two/", title: "Two" },
		],
	});
	const { b } = await attachBrowser(fake);
	await b.open("https://elsewhere/");
	await b.reload();
	await b.cycleTarget();
	fake.deliver({ method: "Target.targetDestroyed", params: { targetId: "T2" } });
	await new Promise((r) => setTimeout(r, 10));
	b.close();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(fake.calls("Target.createTarget").length, 0);
	assert.equal(fake.calls("Target.closeTarget").length, 0);
	assert.ok(!fake.sent.some((m) => m.method.startsWith("Emulation.")), "no emulation ever");
});

test("adapter frame events carry the integer ack id; stale-generation acks are dropped", async () => {
	const fake = makeFakeCdp();
	const { b, got } = await attachBrowser(fake);
	fake.deliver({
		method: "Page.screencastFrame",
		sessionId: "sess-T1",
		params: { data: "AAAA", sessionId: 7, metadata: { deviceWidth: 1600, deviceHeight: 900 } },
	});
	const frame = got.find((m) => m.type === "frame");
	assert.equal(frame.ackId, 7, "integer ack id from params, not the routing string");
	await b.ackFrame(frame.ackId, frame.gen);
	const acks = fake.calls("Page.screencastFrameAck");
	assert.equal(acks.length, 1);
	assert.deepEqual(acks[0].params, { sessionId: 7 });
	assert.equal(acks[0].sessionId, "sess-T1", "routed over the flat-session string");
	await b.restartScreencast();
	await b.ackFrame(frame.ackId, frame.gen); // old generation
	assert.equal(fake.calls("Page.screencastFrameAck").length, 1, "stale ack dropped");
});

test("adapter emits url for the pinned target only; re-pins on destruction only", async () => {
	const fake = makeFakeCdp({
		pages: [
			{ targetId: "T1", type: "page", url: "https://one/", title: "One" },
			{ targetId: "T2", type: "page", url: "https://two/", title: "Two" },
		],
	});
	const { got } = await attachBrowser(fake);
	fake.deliver({
		method: "Target.targetInfoChanged",
		params: { targetInfo: { targetId: "T2", url: "https://noise/", title: "n" } },
	});
	fake.deliver({
		method: "Target.targetInfoChanged",
		params: { targetInfo: { targetId: "T1", url: "https://one/next", title: "One+" } },
	});
	assert.deepEqual(
		got.filter((m) => m.type === "url").map((m) => m.url),
		["https://one/next"],
		"unpinned targets never move the header",
	);
	fake.deliver({
		method: "Target.targetCreated",
		params: { targetInfo: { targetId: "T9", type: "page", url: "https://pop/" } },
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(fake.calls("Target.attachToTarget").length, 1, "creation never re-pins");
	fake.deliver({ method: "Target.targetDestroyed", params: { targetId: "T1" } });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(fake.calls("Target.attachToTarget").length, 2, "destruction re-pins");
});

test("adapter destroyed pin with no survivors emits target_gone", async () => {
	const fake = makeFakeCdp();
	const { got } = await attachBrowser(fake);
	fake.pages.length = 0;
	fake.deliver({ method: "Target.targetDestroyed", params: { targetId: "T1" } });
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(got.some((m) => m.type === "target_gone"));
});

test("adapter navigation: back is a no-op at history start, forward/reload work", async () => {
	const history = {
		currentIndex: 1,
		entries: [{ id: 10 }, { id: 11 }, { id: 12 }],
	};
	const fake = makeFakeCdp({ results: { "Page.getNavigationHistory": () => history } });
	const { b } = await attachBrowser(fake);
	await b.back();
	assert.deepEqual(fake.calls("Page.navigateToHistoryEntry")[0].params, { entryId: 10 });
	await b.forward();
	assert.deepEqual(fake.calls("Page.navigateToHistoryEntry")[1].params, { entryId: 12 });
	history.currentIndex = 0;
	await b.back();
	assert.equal(fake.calls("Page.navigateToHistoryEntry").length, 2, "no-op at boundary");
	await b.reload();
	assert.equal(fake.calls("Page.reload").length, 1);
});

test("adapter input: click is press+release, type is insertText, scroll is mouseWheel", async () => {
	const fake = makeFakeCdp();
	const { b } = await attachBrowser(fake);
	await b.click(120, 240);
	const mouse = fake.calls("Input.dispatchMouseEvent");
	assert.deepEqual(
		mouse.map((m) => m.params.type),
		["mousePressed", "mouseReleased"],
	);
	assert.equal(mouse[0].params.x, 120);
	await b.type("héllo");
	assert.equal(fake.calls("Input.insertText")[0].params.text, "héllo");
	await b.scroll("down", 300);
	const wheel = fake.calls("Input.dispatchMouseEvent").at(-1);
	assert.equal(wheel.params.type, "mouseWheel");
	assert.equal(wheel.params.deltaY, 300);
});

test("adapter feed: log-only tier never sends Runtime.enable", async () => {
	const fake = makeFakeCdp();
	const b = makeCdpBrowser("ws://127.0.0.1:1/devtools/browser/test", {
		consoleTier: "log-only",
		wsFactory: () => {
			queueMicrotask(() => fake.ws.onopen?.());
			return fake.ws;
		},
	});
	b.onMessage(() => {});
	await b.connect();
	assert.equal(fake.calls("Log.enable").length, 1, "Log always on");
	assert.equal(
		fake.calls("Runtime.enable").length,
		0,
		"Runtime.enable is page-observable — the opt-out must really opt out",
	);
	assert.equal(fake.calls("Target.setAutoAttach").length, 1, "OOPIF feed still armed");
});

test("adapter feed: default tier enables Runtime and swallows pre-attach replay", async () => {
	const fake = makeFakeCdp();
	const { b, got } = await attachBrowser(fake);
	assert.equal(fake.calls("Runtime.enable").length, 1);
	const before = b.attachTime() - 5_000;
	const after = b.attachTime() + 5_000;
	fake.deliver({
		method: "Runtime.consoleAPICalled",
		sessionId: "sess-T1",
		params: { type: "log", timestamp: before, args: [{ value: "ancient history" }] },
	});
	fake.deliver({
		method: "Log.entryAdded",
		sessionId: "sess-T1",
		params: { entry: { source: "network", level: "error", timestamp: before, text: "old failure" } },
	});
	assert.equal(got.filter((m) => m.type === "console" || m.type === "log_entry").length, 0,
		"buffered backlog swallowed on both domains");
	fake.deliver({
		method: "Runtime.consoleAPICalled",
		sessionId: "sess-T1",
		params: { type: "warning", timestamp: after, args: [{ value: "live" }, { value: 42 }] },
	});
	const line = got.find((m) => m.type === "console");
	assert.equal(line.level, "warn");
	assert.equal(line.text, "live 42");
});

test("adapter feed: exceptions and network log entries surface with their detail", async () => {
	const fake = makeFakeCdp();
	const { b, got } = await attachBrowser(fake);
	const t = b.attachTime() + 1_000;
	fake.deliver({
		method: "Runtime.exceptionThrown",
		sessionId: "sess-T1",
		params: { timestamp: t, exceptionDetails: { exception: { description: "TypeError: x is not a function" } } },
	});
	assert.equal(got.at(-1).type, "page_error");
	assert.match(got.at(-1).text, /TypeError/);
	fake.deliver({
		method: "Log.entryAdded",
		sessionId: "sess-T1",
		params: { entry: { source: "network", level: "error", timestamp: t, text: "Failed to load resource: net::ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:1/x" } },
	});
	const ne = got.at(-1);
	assert.equal(ne.type, "log_entry");
	assert.match(ne.text, /ERR_CONNECTION_REFUSED/, "real error text, not just a status");
});

test("adapter feed: auto-attached OOPIF sessions get their own feed enabled", async () => {
	const fake = makeFakeCdp();
	await attachBrowser(fake);
	fake.deliver({
		method: "Target.attachedToTarget",
		params: { sessionId: "sess-IFRAME", targetInfo: { targetId: "IF1", type: "iframe" } },
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(
		fake.calls("Log.enable").some((m) => m.sessionId === "sess-IFRAME"),
		"embedded frame failures must not be silent",
	);
});
