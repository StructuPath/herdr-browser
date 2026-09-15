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
import { discoverEndpoint, makeCdpSession } from "../bin/cdp.mjs";

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

test("launch mode drives a real Chromium end to end", {
	skip: process.env.HERDR_BROWSER_REQUIRE_INTEGRATION === "1" ? false : skip,
	timeout: 60_000,
}, async () => {
	assert.equal(skip, false, `integration prerequisites missing: ${skip}`);
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

test("tab selection, target loss and verbatim paste work end to end in Chromium", {
	skip: process.env.HERDR_BROWSER_REQUIRE_INTEGRATION === "1" ? false : skip,
	timeout: 60_000,
}, async () => {
	assert.equal(skip, false, `integration prerequisites missing: ${skip}`);
	const r = new Renderer({
		HERDR_BROWSER_SESSION: "hb-input-int",
		HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "hb-input-int-")),
		HERDR_BROWSER_CHROMIUM: chromium, HOME: os.homedir(), PATH: process.env.PATH,
	});
	r.header = r.renderConsole = r.renderBottom = () => {};
	r.renderImage = async () => {};
	r.mode = "symbols";
	let controller;
	try {
		await r.launchChromium();
		assert.ok(await until(() => r.attached, 30_000), r.banner);
		const endpoint = await discoverEndpoint(r.launchedEndpoint);
		controller = makeCdpSession(endpoint.wsUrl);
		await controller.opened;
		const originalId = r.cdpTargetId;
		const { targetId } = await controller.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await controller.send("Target.attachToTarget", { targetId, flatten: true });
		const evaluate = async expression => {
			const result = await controller.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
			assert.equal(result.exceptionDetails, undefined);
			return result.result.value;
		};
		await evaluate(`document.title = 'Paste fixture'; document.body.innerHTML = '<form><textarea aria-label="Text" style="width:90%;height:200px"></textarea><button>Submit</button></form>'; window.enters = 0; window.submits = 0; document.addEventListener('keydown', e => { if (e.key === 'Enter') window.enters++; }); document.querySelector('form').onsubmit = e => { e.preventDefault(); window.submits++; };`);
		assert.equal(r.cdpTargetId, originalId, "new tabs do not change the selected tab");
		r.onKey("t");
		assert.ok(await until(() => r.targetPicker && !r.targetPicker.loading, 5_000));
		const index = r.targetPicker.targets.findIndex(t => t.targetId === targetId);
		assert.ok(index >= 0);
		while (r.targetPicker.index !== index) r.onKey(r.targetPicker.index < index ? "j" : "k");
		r.onKey("\r");
		assert.ok(await until(() => r.cdpTargetId === targetId && r.lastFrameMeta, 10_000));
		const text = '  first\n\tsecond\n"quotes" \\ $` +^%~(){}[] 漢🙂  ';
		for (const width of [1440, 390]) {
			await controller.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
			await evaluate("document.querySelector('textarea').value = ''; document.querySelector('textarea').focus()");
			r.onKey("i");
			r.feed(`\x1b[200~${text}\x1b[201~`);
			assert.equal(await evaluate("document.querySelector('textarea').value"), "", "paste is staged until confirmed");
			r.feed("\r");
			await r.paintQueue;
			assert.equal(await evaluate("document.querySelector('textarea').value"), text, `verbatim text at viewport width ${width}`);
			assert.equal(await evaluate("window.enters + window.submits"), 0, "insertion never sends Enter or submits the form");
			await r.browser.screenshot(path.join(r.stateDir, `paste-${width}.png`));
		}
		await controller.send("Target.closeTarget", { targetId });
		assert.ok(await until(() => r.cdpTargetId === null, 5_000));
		assert.equal(r.lastFrameMeta, null);
		assert.equal(fs.existsSync(r.shotJpg), false);
		r.onKey("i");
		r.onKey("r");
		assert.equal(r.promptState, null);
		await assert.rejects(r.browser.type("must not reach the surviving tab"), { code: "TARGET_GONE" });
		await r.tick();
		assert.equal(r.attached, true, "browser remains connected after losing the selected tab");
		assert.equal(r.cdpTargetId, null);
		r.onKey("t");
		assert.ok(await until(() => r.targetPicker && !r.targetPicker.loading, 5_000));
		assert.equal(r.targetPicker.targets.length, 1);
		r.onKey("\r");
		assert.ok(await until(() => r.cdpTargetId === originalId, 5_000));
	} finally {
		controller?.close();
		r.cleanup();
	}
});
