import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runQa } from "../bin/qa.mjs";

test("e2e: saved QA runs desktop/mobile assertions and records real browser failures", {
	skip: process.env.HERDR_BROWSER_REQUIRE_QA !== "1" ? "opt in with npm run test:qa (agent-browser + Chromium required)" : false,
	timeout: 180_000,
}, async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-qa-e2e-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-q"); git("config", "user.email", "fixture@example.test"); git("config", "user.name", "Fixture");
	fs.writeFileSync(path.join(repo, "README.md"), "Synthetic browser QA fixture\n");
	git("add", "README.md"); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
	const server = http.createServer((req, res) => {
		if (req.url === "/failure") { res.writeHead(503); res.end("unavailable"); return; }
		if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
		res.setHeader("Content-Type", "text/html");
		res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA fixture</title>
<style>body{font:20px sans-serif;margin:20px}input,button{font:inherit;max-width:100%}</style>
<h1>Ready</h1><input id="name" aria-label="Name"><button id="submit">Confirm</button><p id="result">Waiting</p>
<p id="size"></p><script>
document.querySelector('#size').textContent=innerWidth < 600 ? 'mobile' : 'desktop';
document.querySelector('#submit').onclick=()=>document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value;
${req.url === "/broken" ? "console.error('fixture console error'); setTimeout(()=>{throw new Error('fixture page error')},0); fetch('/failure').then(()=>document.querySelector('#result').textContent='failure observed');" : ""}
</script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
	const config = path.join(root, "scenario.json");
	const scenario = {
		schemaVersion: 1, name: "localhost fixture", baseUrl: `http://127.0.0.1:${server.address().port}`,
		viewports: [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }],
		steps: [{ type: "navigate", path: "/" }, { type: "assertVisible", selector: "h1" },
			{ type: "assertTitle", contains: "QA fixture" }, { type: "fill", selector: "#name", value: "Fixture" },
			{ type: "click", selector: "#submit" }, { type: "assertText", selector: "#result", contains: "Hello Fixture" }],
	};
	fs.writeFileSync(config, JSON.stringify(scenario));
	const passed = await runQa({ config, repo, output: path.join(root, "passed") });
	assert.equal(passed.status, "passed", JSON.stringify(passed));
	assert.equal(passed.git.dirty, false);
	assert.equal(passed.summary.assertions, 6);
	for (const run of passed.runs) {
		const image = fs.readFileSync(path.join(root, "passed", run.artifacts[0].path));
		assert.equal(image.readUInt32BE(16), run.viewport.width);
		assert.equal(image.readUInt32BE(20), run.viewport.height);
	}
	scenario.viewports = [scenario.viewports[0]];
	scenario.steps = [{ type: "navigate", path: "/broken" }, { type: "waitFor", selector: "#result" }, { type: "assertText", selector: "h1", contains: "Deliberately absent" }];
	fs.writeFileSync(config, JSON.stringify(scenario));
	const failed = await runQa({ config, repo, output: path.join(root, "failed") });
	assert.equal(failed.status, "failed");
	assert.equal(failed.cleanup.status, "passed");
	assert.equal(failed.runs[0].artifacts.length, 1);
	assert.ok(failed.runs[0].steps.some((step) => step.status === "failed"));
	assert.ok(failed.runs[0].consoleErrors.some((entry) => entry.message.includes("fixture console error")), JSON.stringify(failed));
	assert.ok(failed.runs[0].pageErrors.some((entry) => entry.message.includes("fixture page error")), JSON.stringify(failed));
	assert.ok(failed.runs[0].failedRequests.some((entry) => entry.status === 503), JSON.stringify(failed));
});
