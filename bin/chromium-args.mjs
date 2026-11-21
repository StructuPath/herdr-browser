// Shared Chromium sandbox fallback for CI and containers.
//
// Chrome's sandbox needs a setuid helper or unprivileged user namespaces;
// root, CI runners, and containers often have neither, so Chrome dies before
// writing DevToolsActivePort and any launch times out. Mirror the signals
// agent-browser keys on and fall back to --no-sandbox there. The companion
// --disable-dev-shm-usage moves shared memory off a tiny container /dev/shm,
// which crashes Chrome the same way. Non-root desktop boxes keep the sandbox.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function chromiumSandboxArgs(env = process.env) {
	const root = typeof process.getuid === "function" && process.getuid() === 0;
	let container = false;
	if (env.CI) {
		container = true;
	} else {
		try {
			container =
				fs.existsSync("/.dockerenv") ||
				fs.existsSync("/run/.containerenv") ||
				/(?:docker|lxc|kubepods|containerd)/i.test(
					fs.readFileSync("/proc/1/cgroup", "utf8"),
				);
		} catch {
			container = false;
		}
	}
	if (!root && !container) return [];
	return container ? ["--no-sandbox", "--disable-dev-shm-usage"] : ["--no-sandbox"];
}

// agent-browser reads AGENT_BROWSER_ARGS (comma or newline separated) for the
// same purpose. Every agent-browser call — the pane, QA, the launchers, and
// recording — goes through this one helper. It APPENDS the fallback to the
// caller's own args (a proxy, a window size) and returns {} when nothing has
// to change. A newline-separated value keeps newlines, so a comma inside one
// arg is never turned into a split point.
export function agentBrowserSandboxEnv(env = process.env) {
	const existing = env.AGENT_BROWSER_ARGS ?? "";
	const have = new Set(existing.split(/[,\n]/).map((a) => a.trim()));
	const add = chromiumSandboxArgs(env).filter((a) => !have.has(a));
	if (!add.length) return {};
	const sep = existing.includes("\n") ? "\n" : ",";
	const base = existing.replace(/[,\n]+$/, "");
	return { AGENT_BROWSER_ARGS: [base, ...add].filter(Boolean).join(sep) };
}

// Shell bridge for the launchers: `node bin/chromium-args.mjs
// --agent-browser-args` writes NUL-terminated records, `keep` or `set`
// followed by the new value. The shell reads them with `read -d ''` (no
// eval), and a value that contains newlines arrives intact.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv[2] !== "--agent-browser-args") {
		process.stderr.write("usage: chromium-args.mjs --agent-browser-args\n");
		process.exit(2);
	}
	const { AGENT_BROWSER_ARGS: value } = agentBrowserSandboxEnv(process.env);
	process.stdout.write(value === undefined ? "keep\0" : `set\0${value}\0`);
}
