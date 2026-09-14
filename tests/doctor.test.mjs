import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../bin/doctor.mjs";

const check = (env = {}, available = [], options = {}) => diagnose(env, {
	probe: (name) => available.includes(name), readConfig: () => "", nodeVersion: "22.0.0", webSocket: true, ...options,
});
const errors = (checks) => checks.filter((c) => c.status === "error");

test("doctor accepts shared sessions and treats rendering tools as optional", () => {
	const checks = check({}, ["herdr", "agent-browser"]);
	assert.deepEqual(errors(checks), []);
	assert.ok(checks.some((c) => c.name === "Image rendering" && c.status === "warn"));
});

test("doctor requires a usable engine and Herdr", () => {
	assert.equal(errors(check()).length, 2);
	assert.equal(errors(check({}, ["herdr", "google-chrome"])).length, 0);
	assert.equal(errors(check({}, ["herdr", "google-chrome"], { webSocket: false })).length, 1);
});

test("doctor honors selected backend and never prints endpoint credentials", () => {
	const env = { HERDR_BROWSER_CDP_URL: "wss://user:secret@example.com/devtools/browser/private-token", HERDR_BROWSER_LAUNCH: "1" };
	const checks = check(env, ["herdr"]);
	assert.deepEqual(errors(checks), []);
	assert.doesNotMatch(JSON.stringify(checks), /secret|private-token/);
	assert.equal(errors(check(env, ["herdr"], { webSocket: false })).length, 1);
	assert.equal(errors(check({ HERDR_BROWSER_CDP_URL: "bad" }, ["herdr"])).length, 1);
});

test("doctor checks explicit Chromium executability and configuration files", () => {
	assert.equal(errors(check({ HERDR_BROWSER_LAUNCH: "1", HERDR_BROWSER_CHROMIUM: "/missing" }, ["herdr", "agent-browser"])).length, 1);
	assert.deepEqual(errors(check({}, ["herdr", "/custom/chrome"], {
		readConfig: (name) => ({ launch: "true", chromium: "/custom/chrome" })[name] || "",
	})), []);
});
