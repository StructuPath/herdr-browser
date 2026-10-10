// Shared Chromium sandbox fallback for CI and containers.
//
// Chrome's sandbox needs a setuid helper or unprivileged user namespaces;
// root, CI runners, and containers often have neither, so Chrome dies before
// writing DevToolsActivePort and any launch times out. Mirror the signals
// agent-browser keys on and fall back to --no-sandbox there. The companion
// --disable-dev-shm-usage moves shared memory off a tiny container /dev/shm,
// which crashes Chrome the same way. Non-root desktop boxes keep the sandbox.
import fs from "node:fs";

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
// same purpose; the pane's shared-session backend and the QA runner both drive
// agent-browser, so both need it on CI/container boxes.
export function agentBrowserSandboxEnv(env = process.env) {
	const args = chromiumSandboxArgs(env);
	return args.length ? { AGENT_BROWSER_ARGS: args.join(",") } : {};
}
