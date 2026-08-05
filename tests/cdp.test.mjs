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
