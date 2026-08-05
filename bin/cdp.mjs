// Zero-dependency Chrome DevTools Protocol client for attach mode.
// The pane attaches to a browser someone else owns (Playwright, Puppeteer,
// Browser Use, plain --remote-debugging-port Chrome) — so this layer never
// creates or closes targets and exposes no listening port of its own.
import http from "node:http";
import net from "node:net";

// Attach mode needs a WebSocket client; Node grew a global one in 22.
// On Node 20 the pane keeps working in agent-browser mode — callers gate on
// this instead of crashing at connect time.
export function cdpSupported() {
	return typeof WebSocket === "function";
}

// DevTools ws URLs are capability tokens (a GUID path grants full browser
// control). Anything user-visible — header, banners, logs — gets host:port
// only, never the path.
export function redactWsUrl(url) {
	try {
		const u = new URL(url);
		return u.host;
	} catch {
		return "invalid endpoint";
	}
}

// GET a /json/* endpoint over node:http. WHATWG fetch cannot send a custom
// Host header (undici silently drops it), and Chrome 111+ rejects /json/*
// requests whose Host is a DNS name — so we dial the resolved address and
// send an IP-literal Host explicitly.
function getJson(host, port, path, timeout = 5_000) {
	return new Promise((resolve, reject) => {
		const hostHeader = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
		const req = http.request(
			{ host, port, path, method: "GET", headers: { Host: hostHeader }, timeout },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					body += c;
					if (body.length > 4 * 1024 * 1024) req.destroy(new Error("oversized /json response"));
				});
				res.on("end", () => {
					if (res.statusCode !== 200)
						return reject(new Error(`endpoint answered ${res.statusCode} for ${path}`));
					try {
						resolve(JSON.parse(body));
					} catch {
						reject(new Error(`endpoint returned non-JSON for ${path}`));
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("endpoint timed out")));
		req.on("error", reject);
		req.end();
	});
}

// Resolve a user-supplied endpoint — http(s)://host:port or a browser-level
// ws:// URL — to { wsUrl, host, port, browser (product string), pages }.
// A pasted page-level URL (/devtools/page/<id>) is refused with a pointer at
// the browser endpoint: Target.attachToTarget only works browser-level, and
// this is the most common paste mistake from /json/list output.
export async function discoverEndpoint(input, { lookup } = {}) {
	let u;
	try {
		u = new URL(String(input).trim());
	} catch {
		throw new Error("not an endpoint URL — use http://host:port or ws://…");
	}
	if (/\/devtools\/page\//.test(u.pathname))
		throw new Error(
			"that is a page-level DevTools URL — use the browser endpoint (http://host:port or /devtools/browser/…)",
		);
	if (u.protocol === "ws:" || u.protocol === "wss:") {
		// Raw ws endpoint: no HTTP discovery surface; identity fields best-effort.
		return {
			wsUrl: u.href,
			host: u.hostname,
			port: u.port,
			browser: null,
			guid: u.pathname.split("/").pop() || null,
			pages: [],
			rediscoverable: false,
		};
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		throw new Error("not an endpoint URL — use http://host:port or ws://…");
	let host = u.hostname.replace(/^\[|\]$/g, "");
	if (!net.isIP(host)) {
		const resolve = lookup ?? (await import("node:dns/promises")).lookup;
		host = (await resolve(host)).address;
	}
	const port = u.port || "9222";
	const version = await getJson(host, port, "/json/version");
	const wsUrl = version.webSocketDebuggerUrl;
	if (!wsUrl) throw new Error("endpoint has no webSocketDebuggerUrl — not a DevTools endpoint");
	let pages = [];
	try {
		const list = await getJson(host, port, "/json/list");
		if (Array.isArray(list)) pages = list.filter((t) => t.type === "page");
	} catch {
		/* list is best-effort; attach can enumerate targets itself */
	}
	return {
		wsUrl,
		host,
		port,
		browser: version.Browser ?? null,
		guid: new URL(wsUrl).pathname.split("/").pop() || null,
		pages,
		rediscoverable: true,
	};
}

// A CDP connection over the browser-level socket with flat sessions:
// requests carry an optional sessionId, responses correlate by id, events
// route to subscribers. Never throws out of the message handler — a torn
// frame from a dying browser must not become an uncaughtException.
export function makeCdpSession(wsUrl, { wsFactory } = {}) {
	const factory = wsFactory ?? ((url) => new WebSocket(url));
	const ws = factory(wsUrl);
	let msgId = 0;
	let dead = false;
	const pending = new Map(); // id -> {resolve, reject, timer}
	const handlers = new Set(); // fn({method, params, sessionId})
	const closers = new Set();
	const failAll = (why) => {
		if (dead) return;
		dead = true;
		for (const { reject, timer } of pending.values()) {
			clearTimeout(timer);
			reject(new Error(why));
		}
		pending.clear();
		for (const fn of closers) {
			try {
				fn(why);
			} catch {
				/* subscriber's problem */
			}
		}
	};
	const opened = new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			try {
				ws.close();
			} catch {
				/* fine */
			}
			reject(new Error("endpoint connect timed out"));
		}, 5_000);
		ws.onopen = () => {
			clearTimeout(t);
			resolve();
		};
		ws.onerror = () => {
			clearTimeout(t);
			reject(new Error("endpoint refused the connection"));
			failAll("connection failed");
		};
	});
	ws.onclose = () => failAll("connection closed");
	ws.onmessage = (ev) => {
		let m;
		try {
			m = JSON.parse(ev.data);
		} catch {
			return;
		}
		if (m.id !== undefined && pending.has(m.id)) {
			const { resolve, reject, timer } = pending.get(m.id);
			pending.delete(m.id);
			clearTimeout(timer);
			if (m.error) reject(new Error(m.error.message || "CDP error"));
			else resolve(m.result);
			return;
		}
		if (m.method) {
			for (const fn of handlers) {
				try {
					fn(m);
				} catch {
					/* one bad subscriber must not drop events for the rest */
				}
			}
		}
	};
	return {
		opened,
		send(method, params = {}, sessionId, timeout = 10_000) {
			if (dead) return Promise.reject(new Error("connection closed"));
			return new Promise((resolve, reject) => {
				const id = ++msgId;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`${method} timed out`));
				}, timeout);
				pending.set(id, { resolve, reject, timer });
				try {
					ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
				} catch (err) {
					pending.delete(id);
					clearTimeout(timer);
					reject(err);
				}
			});
		},
		onEvent(fn) {
			handlers.add(fn);
			return () => handlers.delete(fn);
		},
		onClose(fn) {
			closers.add(fn);
		},
		// Liveness probe: half-open sockets can sit silent for minutes; a
		// bounded getVersion answers "is anyone there" without side effects.
		async ping(timeout = 4_000) {
			try {
				await this.send("Browser.getVersion", {}, undefined, timeout);
				return true;
			} catch {
				return false;
			}
		},
		get dead() {
			return dead;
		},
		close() {
			dead = true;
			try {
				ws.close();
			} catch {
				/* already closed */
			}
		},
	};
}
