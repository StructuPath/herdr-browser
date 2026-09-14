#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { findChromium, truthyConfig } from "./renderer.mjs";

export function diagnose(env = process.env, {
	probe = (command) => spawnSync("/bin/sh", ["-c", 'command -v -- "$1"', "sh", command], {
		env, timeout: 5_000, stdio: "ignore",
	}).status === 0,
	readConfig = (name) => {
		if (!env.HERDR_PLUGIN_CONFIG_DIR) return "";
		try { return fs.readFileSync(path.join(env.HERDR_PLUGIN_CONFIG_DIR, name), "utf8").split("\n")[0].trim(); }
		catch { return ""; }
	},
	nodeVersion = process.versions.node,
	webSocket = typeof WebSocket === "function",
} = {}) {
	const checks = [];
	const add = (status, name, detail) => checks.push({ status, name, detail });
	add(Number(nodeVersion.split(".")[0]) >= 20 ? "ok" : "error", "Node.js", `${nodeVersion}; Node 22+ recommended for streaming, attach, and launch`);
	add(probe(env.HERDR_BIN_PATH || "herdr") ? "ok" : "error", "Herdr CLI", "requires Herdr >= 0.7.0; set HERDR_BIN_PATH if it is not on PATH");
	const agent = probe("agent-browser");
	const chromium = findChromium(env, readConfig("chromium"), probe);
	const launchable = !!chromium && probe(chromium);
	const endpoint = String(env.HERDR_BROWSER_CDP_URL || readConfig("cdp-url")).trim();
	const launch = truthyConfig(env.HERDR_BROWSER_LAUNCH || readConfig("launch"));
	if (endpoint) {
		let valid = false;
		try { valid = ["http:", "https:", "ws:", "wss:"].includes(new URL(endpoint).protocol); } catch {}
		add(valid && webSocket ? "ok" : "error", "Selected backend: attach", valid ? "endpoint configured (not contacted); requires Node 22+" : "invalid endpoint; use http://host:port or a browser WebSocket URL");
	} else if (launch) {
		add(launchable && webSocket ? "ok" : "error", "Selected backend: launch", "requires Node 22+ and an executable Chrome/Chromium; set HERDR_BROWSER_CHROMIUM");
	} else {
		add(agent || (launchable && webSocket) ? "ok" : "error", "Browser engine", agent ? "agent-browser available; install its engine with agent-browser install" : launchable && webSocket ? "Chrome/Chromium available; press l or set HERDR_BROWSER_LAUNCH=1" : "install agent-browser and run agent-browser install, or configure Chrome/Chromium with Node 22+");
	}
	add(launchable ? "ok" : "warn", "Local Chromium", launchable ? "executable found; launch not attempted" : "not found; optional for shared agent sessions and external attach");
	add(probe("chafa") ? "ok" : "warn", "Image rendering", "chafa enables ANSI images and Kitty JPEGs; macOS: brew install chafa");
	add(probe("carbonyl") ? "ok" : "warn", "Interactive Browse", "Carbonyl is optional and uses a separate browser session");
	return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const checks = diagnose();
	for (const { status, name, detail } of checks) console.log(`${status.toUpperCase()} ${name}: ${detail}`);
	console.log("Prerequisite check only. No browsers launched, endpoints contacted, or configuration changed.");
	process.exitCode = checks.some((c) => c.status === "error") ? 1 : 0;
}
