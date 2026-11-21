#!/usr/bin/env node
// hb: read what the Browser pane of this workspace observes. For the coding
// agent beside the pane: the renderer publishes pane-<ws>.json (see
// bin/pane-state.mjs); this reads it back and names the session to drive.
// Read-only: hb never creates the state dir or touches the browser.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deriveSession, resolveStateDir, safeWsId, sanitizeText } from "./renderer.mjs";
import { paneStateFile, pidAlive, readPaneState } from "./pane-state.mjs";

// Stable, documented in README "For agents: reading the pane".
export const EXIT = { ok: 0, error: 1, usage: 2, noPane: 3 };

const PLUGIN_ID = "structupath.browser";

const HELP = `hb — read the Browser pane of this herdr workspace

Usage:
  hb status [--json]    what the pane shows: backend, session, endpoint,
                        url, title, observe-only, console and failure tails
  hb session [--json]   the agent-browser session name to drive, and the
                        CDP host:port when the pane is attached or launched
  hb help               this text

The workspace comes from HERDR_WORKSPACE_ID; the session name is derived
exactly as the pane derives it (see README "Session model").

Exit codes:
  0  success
  1  the pane file exists but cannot be read or parsed
  2  usage error (unknown command or flag)
  3  no live pane for this workspace (hb status only)
`;

// Where the pane may have written its file. herdr hands the pane
// HERDR_PLUGIN_STATE_DIR, but the agent's own shell usually lacks it: then
// look in herdr's per-plugin state dir before the renderer's own fallback.
export function stateDirCandidates(env) {
	if (env.HERDR_PLUGIN_STATE_DIR) return [resolveStateDir(env)];
	const home = env.HOME || os.homedir();
	const dirs = [];
	if (env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME))
		dirs.push(path.join(env.XDG_STATE_HOME, "herdr/plugins", PLUGIN_ID));
	dirs.push(path.join(home, ".local/state/herdr/plugins", PLUGIN_ID));
	dirs.push(resolveStateDir({ ...env, HOME: home }));
	return [...new Set(dirs)];
}

// { state, file } for the first live pane; { state: null } when none is
// live (missing file or dead pid); { error } when a file is unreadable and
// no candidate is live.
export function findPane(env) {
	const ws = safeWsId(env.HERDR_WORKSPACE_ID);
	let error = null;
	for (const dir of stateDirCandidates(env)) {
		const file = paneStateFile(dir, ws);
		let state;
		try {
			state = readPaneState(file);
		} catch (err) {
			error ??= `${file}: ${err.message}`;
			continue;
		}
		if (state && pidAlive(state.pid)) return { state, file };
	}
	return error ? { error } : { state: null };
}

const clean = (v) => sanitizeText(String(v ?? ""));

function printStatusText(s) {
	const rows = [
		["backend", s.backend],
		["session", s.session],
		["endpoint", s.endpoint ?? "-"],
		["attached", s.attached],
		["url", s.url],
		["title", s.title],
		["observeOnly", s.observeOnly],
		["updatedAt", s.updatedAt],
		["pid", s.pid],
	];
	const out = rows.map(([k, v]) => `${`${k}:`.padEnd(13)}${clean(v)}`);
	for (const [k, list] of [["console", s.consoleTail], ["failures", s.failures]]) {
		const lines = Array.isArray(list) ? list : [];
		out.push(`${k} (${lines.length}):`);
		for (const l of lines) out.push(`  ${clean(l)}`);
	}
	process.stdout.write(`${out.join("\n")}\n`);
}

function status(env, json) {
	const found = findPane(env);
	if (found.error) {
		if (json) process.stdout.write(`${JSON.stringify({ status: "error", error: found.error })}\n`);
		else process.stderr.write(`hb: cannot read pane state: ${clean(found.error)}\n`);
		return EXIT.error;
	}
	if (!found.state) {
		if (json) process.stdout.write(`${JSON.stringify({ status: "no-pane" })}\n`);
		else process.stdout.write("no browser pane is running for this workspace\n");
		return EXIT.noPane;
	}
	if (json) process.stdout.write(`${JSON.stringify(found.state)}\n`);
	else printStatusText(found.state);
	return EXIT.ok;
}

// A live pane is authoritative (it may hold config the agent's shell lacks);
// otherwise derive the name the pane would use. Session never fails: the
// agent can drive agent-browser before the pane opens.
function session(env, cwd, json) {
	const found = findPane(env);
	const live = found.state && typeof found.state.session === "string" && found.state.session;
	const out = live
		? {
				session: found.state.session,
				source: "pane",
				backend: found.state.backend ?? null,
				endpoint: found.state.endpoint ?? null,
			}
		: { session: deriveSession(env, cwd), source: "derived", backend: null, endpoint: null };
	if (json) {
		process.stdout.write(`${JSON.stringify(out)}\n`);
		return EXIT.ok;
	}
	const lines = [`session: ${clean(out.session)}`];
	if (out.endpoint) {
		lines.push(`endpoint: ${clean(out.endpoint)}`);
		lines.push(
			`drive it: agent-browser --session ${clean(out.session)} connect http://${clean(out.endpoint)}`,
		);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return EXIT.ok;
}

export function main(argv, env = process.env, cwd = process.cwd()) {
	const [cmd = "help", ...rest] = argv;
	if (cmd === "help" || cmd === "--help" || cmd === "-h") {
		process.stdout.write(HELP);
		return EXIT.ok;
	}
	if (cmd !== "status" && cmd !== "session") {
		process.stderr.write(`hb: unknown command: ${clean(cmd)}\n\n${HELP}`);
		return EXIT.usage;
	}
	const bad = rest.find((a) => a !== "--json");
	if (bad !== undefined) {
		process.stderr.write(`hb ${cmd}: unknown argument: ${clean(bad)}\n`);
		return EXIT.usage;
	}
	const json = rest.includes("--json");
	return cmd === "status" ? status(env, json) : session(env, cwd, json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
