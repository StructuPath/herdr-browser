// Real-browser integration: launch mode end to end against an installed
// Chromium. Skips where the run cannot work — no Chromium on the machine, or
// no WebSocket client (Node < 22) — so the suite stays green everywhere while
// CI with a browser exercises the true path: spawn, DevToolsActivePort,
// attach, navigate, screencast frame, console feed, child kill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Renderer, findChromium } from "../bin/renderer.mjs";

const probe = (c) =>
	spawnSync("sh", ["-c", 'command -v -- "$1"', "sh", c], { timeout: 5000 })
		.status === 0;
const chromium = findChromium(process.env, undefined, probe);
const skip =
	typeof WebSocket !== "function"
		? "needs Node 22+ (global WebSocket)"
		: !chromium
			? "no Chromium installed"
			: false;

const until = async (cond, ms) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return cond();
};

test("launch mode drives a real Chromium end to end", { skip }, async () => {
	const r = new Renderer({
		HERDR_BROWSER_SESSION: "hb-launch-int",
		HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "hb-int-")),
		HERDR_BROWSER_CHROMIUM: chromium,
		HOME: os.homedir(),
		PATH: process.env.PATH,
	});
	r.header = () => {};
	r.renderConsole = () => {};
	r.renderBottom = () => {};
	r.renderImage = async () => {};
	r.mode = "symbols"; // what run() would have picked; the backend must survive it

	let frames = 0;
	const orig = r.onCdpMessage.bind(r);
	r.onCdpMessage = (m) => {
		if (m.type === "frame") frames++;
		orig(m);
	};

	let pid;
	try {
		await r.launchChromium();
		assert.ok(
			await until(() => r.attached, 30_000),
			`pane should attach to the launched browser (banner: ${r.banner})`,
		);
		pid = r.launchedChild?.pid;
		assert.ok(pid, "the pane records the child it owns");
		assert.equal(r.backend, "attach");
		assert.equal(r.mode, "symbols", "render mode survives the launch");

		await r.browser.open("data:text/html,<title>hb-int</title>ok");
		assert.ok(
			await until(() => /hb-int|data:text\/html/.test(r.lastUrl), 10_000),
			`navigation should surface in the header state (url: ${r.lastUrl})`,
		);
		assert.ok(
			await until(() => frames > 0, 10_000),
			"at least one screencast frame arrives",
		);

		await r.browser.open(
			"data:text/html,<script>console.error('hb-int-boom')</script>",
		);
		assert.ok(
			await until(
				() => r.consoleLines.some((l) => l.includes("hb-int-boom")),
				10_000,
			),
			"page console output reaches the pane feed",
		);
	} finally {
		r.cleanup();
	}
	if (pid) {
		assert.ok(
			await until(() => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			}, 5_000),
			"quit must kill the browser the pane launched",
		);
	}
});
