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

// --- Renderer-facing backend adapter ---

// The attach-mode counterpart of makeBrowser. It deliberately has NO
// setViewport (the automation client owns emulation — competitors that
// override it fight their own clients), NO network (the polling failure
// feed is agent-browser-specific; attach mode feeds the console from CDP
// events), and NO snapshot/streamEnable/streamStatus (frames are pushed).
// The Renderer's existing typeof guards turn those absences into disabled
// features instead of crashes. It never calls Target.createTarget,
// Target.closeTarget, or Emulation.* — the pane observes, it does not own.
export function makeCdpBrowser(endpointInput, opts = {}) {
	const quality = opts.quality ?? 60;
	const maxDim = opts.maxDim ?? 1280;
	const consoleTier = opts.consoleTier === "log-only" ? "log-only" : "runtime+log";
	let session = null;
	let endpoint = null;
	let pageSessionId = null;
	let pinnedTargetId = null;
	let gen = 0; // screencast generation: stale acks and frames are discarded
	let lastMeta = null; // latest frame metadata (deviceWidth/Height for input scaling)
	let handler = null; // onMessage subscriber (the Renderer)
	let attachTimeMs = 0;
	const emit = (m) => {
		try {
			handler?.(m);
		} catch {
			/* the Renderer guards its own paint path */
		}
	};

	const pageTargets = async () => {
		const { targetInfos } = await session.send("Target.getTargets");
		return targetInfos.filter((t) => t.type === "page");
	};

	const startScreencast = async () => {
		const g = ++gen;
		await session.send(
			"Page.startScreencast",
			{ format: "jpeg", quality, maxWidth: maxDim, maxHeight: maxDim, everyNthFrame: 1 },
			pageSessionId,
		);
		return g;
	};

	// Console/error/network feed. Log is always on: it carries network
	// failures with Chrome's real error text (net::ERR_*), detail the
	// agent-browser daemon drops entirely. Runtime is opt-out because
	// Runtime.enable is page-observable — stealth automation stacks avoid it,
	// and observing a run must not be able to change its outcome.
	const enableFeed = async (sessionId) => {
		await session.send("Log.enable", {}, sessionId);
		if (consoleTier !== "log-only")
			await session.send("Runtime.enable", {}, sessionId);
	};

	const pinTarget = async (targetId) => {
		const { sessionId } = await session.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		pinnedTargetId = targetId;
		pageSessionId = sessionId;
		await session.send("Page.enable", {}, sessionId);
		await enableFeed(sessionId);
		// Events-only auto-attach: OOPIFs and workers deliver their console and
		// network failures on their own sessions, and a broken embedded frame
		// with a silent console is exactly the case this feature exists for.
		// Rendering and input stay pinned to the page target.
		try {
			await session.send(
				"Target.setAutoAttach",
				{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				sessionId,
			);
		} catch {
			/* older engines: page-level feed only */
		}
		try {
			await startScreencast();
		} catch (err) {
			// Firefox's CDP subset has no Page.startScreencast: name the reason
			// instead of surfacing a raw protocol error nobody can act on.
			if (/wasn't found|not found|not supported|unknown method/i.test(err?.message ?? ""))
				throw new Error(
					"browser has no CDP screencast (Firefox?) — attach needs a Chromium-based browser",
				);
			throw err;
		}
	};

	const onCdpEvent = (m) => {
		if (m.method === "Page.screencastFrame" && m.sessionId === pageSessionId) {
			lastMeta = m.params.metadata ?? null;
			emit({
				type: "frame",
				data: m.params.data,
				metadata: lastMeta,
				// Two distinct ids: params.sessionId is the INTEGER the ack must
				// echo; m.sessionId is the flat-session routing string. Conflate
				// them and Chrome ignores the ack — the stream freezes at quota.
				ackId: m.params.sessionId,
				gen,
			});
			return;
		}
		if (m.method === "Target.targetInfoChanged") {
			const t = m.params.targetInfo;
			if (t.targetId === pinnedTargetId)
				emit({ type: "url", url: t.url, title: t.title });
			return;
		}
		if (m.method === "Target.targetDestroyed") {
			if (m.params.targetId !== pinnedTargetId) return;
			pinnedTargetId = null;
			pageSessionId = null;
			// Re-pin only on destruction of OUR target — never follow creation.
			pageTargets()
				.then(async (pages) => {
					if (!pages.length) return emit({ type: "target_gone" });
					await pinTarget(pages[0].targetId);
					emit({ type: "url", url: pages[0].url, title: pages[0].title });
				})
				.catch(() => emit({ type: "target_gone" }));
			return;
		}
		if (m.method === "Inspector.targetCrashed" && m.sessionId === pageSessionId) {
			emit({ type: "page_error", text: "page crashed — waiting for reload" });
			return;
		}
		// A newly auto-attached OOPIF/worker session needs its own feed.
		if (m.method === "Target.attachedToTarget") {
			const sid = m.params.sessionId;
			enableFeed(sid).catch(() => {});
			return;
		}
		if (m.method === "Runtime.consoleAPICalled") {
			if (isReplay(m.params.timestamp)) return;
			emit({
				type: "console",
				level: m.params.type === "warning" ? "warn" : m.params.type,
				text: consoleArgsText(m.params.args),
			});
			return;
		}
		if (m.method === "Runtime.exceptionThrown") {
			if (isReplay(m.params.timestamp)) return;
			const d = m.params.exceptionDetails ?? {};
			emit({
				type: "page_error",
				text: d.exception?.description ?? d.text ?? "uncaught exception",
			});
			return;
		}
		if (m.method === "Log.entryAdded") {
			const e = m.params.entry ?? {};
			if (isReplay(e.timestamp)) return;
			emit({
				type: "log_entry",
				source: e.source,
				level: e.level,
				text: e.text ?? "",
				url: e.url ?? "",
			});
		}
	};

	// Chrome flushes buffered console/log history when the domains are
	// enabled — the same wall-of-history problem the network feed's silent
	// baseline solves. CDP timestamps are ms since epoch.
	const isReplay = (ts) =>
		typeof ts === "number" && attachTimeMs > 0 && ts < attachTimeMs;

	// Console args are page-controlled and can be huge; take the shallow text
	// only. No Runtime.getProperties — that would both bloat the pane and
	// deepen the observable footprint on the page.
	const consoleArgsText = (args) =>
		(args ?? [])
			.map((a) => {
				if (a.unserializableValue !== undefined) return String(a.unserializableValue);
				if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
				return a.description ?? a.className ?? a.type ?? "";
			})
			.join(" ")
			.slice(0, 2_000);

	return {
		// Identity of what we're attached to; the Renderer compares guid across
		// reattaches so a reused port can't silently swap browsers underneath.
		async connect() {
			endpoint = await discoverEndpoint(endpointInput, opts);
			session = makeCdpSession(endpoint.wsUrl, opts);
			await session.opened;
			session.onEvent(onCdpEvent);
			session.onClose(() => emit({ type: "endpoint_gone" }));
			await session.send("Target.setDiscoverTargets", { discover: true });
			const pages = await pageTargets();
			if (!pages.length) throw new Error("endpoint has no page targets");
			attachTimeMs = Date.now();
			await pinTarget(pages[0].targetId);
			return {
				host: endpoint.host,
				port: endpoint.port,
				browser: endpoint.browser,
				guid: endpoint.guid,
				rediscoverable: endpoint.rediscoverable,
				url: pages[0].url,
				title: pages[0].title,
			};
		},
		onMessage(fn) {
			handler = fn;
		},
		attachTime: () => attachTimeMs,
		frameMetadata: () => lastMeta,
		// Ack path for the Renderer's paint-settle hook. Generation-guarded so
		// an ack from before a restart/re-pin can never reach a new screencast.
		async ackFrame(ackId, frameGen) {
			if (frameGen !== gen || !pageSessionId) return;
			try {
				await session.send("Page.screencastFrameAck", { sessionId: ackId }, pageSessionId);
			} catch {
				/* stream may be mid-restart; the watchdog covers a stall */
			}
		},
		async restartScreencast() {
			try {
				await session.send("Page.stopScreencast", {}, pageSessionId);
			} catch {
				/* already stopped */
			}
			await startScreencast();
		},
		async cycleTarget() {
			const pages = await pageTargets();
			if (pages.length < 2) return false;
			const i = pages.findIndex((t) => t.targetId === pinnedTargetId);
			const next = pages[(i + 1) % pages.length];
			try {
				await session.send("Page.stopScreencast", {}, pageSessionId);
			} catch {
				/* old session may be gone */
			}
			await pinTarget(next.targetId);
			emit({ type: "url", url: next.url, title: next.title });
			return true;
		},
		async open(u) {
			await session.send("Page.navigate", { url: u }, pageSessionId);
		},
		async back() {
			const h = await session.send("Page.getNavigationHistory", {}, pageSessionId);
			if (h.currentIndex <= 0) return;
			await session.send(
				"Page.navigateToHistoryEntry",
				{ entryId: h.entries[h.currentIndex - 1].id },
				pageSessionId,
			);
		},
		async forward() {
			const h = await session.send("Page.getNavigationHistory", {}, pageSessionId);
			if (h.currentIndex >= h.entries.length - 1) return;
			await session.send(
				"Page.navigateToHistoryEntry",
				{ entryId: h.entries[h.currentIndex + 1].id },
				pageSessionId,
			);
		},
		async reload() {
			await session.send("Page.reload", {}, pageSessionId);
		},
		// x/y arrive in page CSS pixels — the Renderer scales pane cells ->
		// frame pixels -> CSS via the per-frame metadata before calling.
		async click(x, y) {
			const base = { x, y, button: "left", clickCount: 1 };
			await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, pageSessionId);
			await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, pageSessionId);
		},
		async scroll(dir, px) {
			const m = lastMeta;
			const cx = m ? Math.floor((m.deviceWidth ?? 800) / 2) : 400;
			const cy = m ? Math.floor((m.deviceHeight ?? 600) / 2) : 300;
			await session.send(
				"Input.dispatchMouseEvent",
				{ type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: dir === "down" ? px : -px },
				pageSessionId,
			);
		},
		async type(text) {
			await session.send("Input.insertText", { text }, pageSessionId);
		},
		async screenshot(file) {
			const { data } = await session.send(
				"Page.captureScreenshot",
				{ format: "png" },
				pageSessionId,
				15_000,
			);
			const fs = await import("node:fs");
			fs.writeFileSync(file, Buffer.from(data, "base64"));
		},
		async sessionExists() {
			if (!session || session.dead || !pinnedTargetId) return false;
			return session.ping();
		},
		close() {
			const s = session;
			if (!s || s.dead) return;
			// Attach-mode cleanup: stop OUR screencast, close OUR socket.
			// Never a Target.closeTarget, never an agent-browser subprocess.
			const done = pageSessionId
				? s.send("Page.stopScreencast", {}, pageSessionId, 1_000).catch(() => {})
				: Promise.resolve();
			done.finally(() => s.close());
		},
		_session: () => session, // U4 console wiring + tests reach the raw session
	};
}
