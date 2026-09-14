#!/usr/bin/env node
// This plugin ships source directly; building verifies the runnable package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateRepository } from "./check-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
for (const dir of ["bin", "scripts", "tests"]) {
	for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
		const file = path.join(dir, name);
		const command = name.endsWith(".mjs") ? process.execPath : name.endsWith(".sh") ? "bash" : null;
		if (!command) continue;
		const result = spawnSync(command, [command === "bash" ? "-n" : "--check", file], {
			cwd: root, stdio: "inherit", timeout: 10_000,
		});
		if (result.error || result.status !== 0) {
			console.error(`Build failed: ${file}${result.error ? `: ${result.error.message}` : ""}`);
			process.exit(1);
		}
		count++;
	}
}
const { errors, entrypointCount } = validateRepository(root);
if (errors.length) {
	for (const error of errors) console.error(error);
	process.exitCode = 1;
} else {
	console.log(`Build verified: ${count} source files, ${entrypointCount} manifest entrypoints. No compilation required.`);
}
