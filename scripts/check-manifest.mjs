#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOML_TO_JSON = `
import json
import sys
import tomllib

with open(sys.argv[1], "rb") as manifest:
    json.dump(tomllib.load(manifest), sys.stdout)
`;

function parseManifest(manifestPath) {
	const result = spawnSync("python3", ["-c", TOML_TO_JSON, manifestPath], {
		encoding: "utf8",
	});
	if (result.error) {
		throw new Error(
			`could not run python3 to parse the manifest: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		throw new Error(`manifest is not valid TOML: ${result.stderr.trim()}`);
	}
	return JSON.parse(result.stdout);
}

function manifestCommands(manifest, errors) {
	const commands = [];
	for (const section of ["build", "startup", "actions", "panes", "events"]) {
		const entries = manifest[section] ?? [];
		if (!Array.isArray(entries)) {
			errors.push(`manifest section ${section} must be an array`);
			continue;
		}
		for (const [index, entry] of entries.entries()) {
			if (!Array.isArray(entry.command) || entry.command.length === 0) {
				errors.push(
					`${section}[${index}] must declare a non-empty command array`,
				);
				continue;
			}
			commands.push({ label: `${section}[${index}]`, command: entry.command });
		}
	}
	return commands;
}

function commandEntrypoint(command) {
	if (["bash", "node", "sh"].includes(command[0])) return command[1];
	if (typeof command[0] === "string" && command[0].includes("/")) {
		return command[0];
	}
	return null;
}

function isContained(root, target) {
	const relative = path.relative(root, target);
	return (
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

export function validateRepository(root) {
	const errors = [];
	let packageJson;
	let manifest;

	try {
		packageJson = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		);
	} catch (error) {
		errors.push(`package.json could not be parsed: ${error.message}`);
	}

	try {
		manifest = parseManifest(path.join(root, "herdr-plugin.toml"));
	} catch (error) {
		errors.push(error.message);
	}

	if (!packageJson || !manifest) {
		return { errors, entrypointCount: 0, scriptCount: 0 };
	}

	if (typeof manifest.version !== "string") {
		errors.push("manifest version must be a string");
	} else if (packageJson.version !== manifest.version) {
		errors.push(
			`version mismatch: package.json=${packageJson.version} herdr-plugin.toml=${manifest.version}`,
		);
	}

	const commands = manifestCommands(manifest, errors);
	const resolvedRoot = fs.realpathSync(root);
	let entrypointCount = 0;
	for (const { label, command } of commands) {
		const entrypoint = commandEntrypoint(command);
		if (!entrypoint) continue;
		entrypointCount += 1;
		if (typeof entrypoint !== "string") {
			errors.push(`${label} entrypoint must be a string`);
			continue;
		}
		const target = path.resolve(resolvedRoot, entrypoint);
		if (!isContained(resolvedRoot, target)) {
			errors.push(`${label} entrypoint escapes the repository: ${entrypoint}`);
			continue;
		}
		if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
			errors.push(`${label} entrypoint does not exist: ${entrypoint}`);
			continue;
		}
		if (!isContained(resolvedRoot, fs.realpathSync(target))) {
			errors.push(`${label} entrypoint escapes the repository: ${entrypoint}`);
		}
	}

	const scriptsDir = path.join(resolvedRoot, "scripts");
	let scripts = [];
	try {
		scripts = fs
			.readdirSync(scriptsDir)
			.filter((name) => fs.statSync(path.join(scriptsDir, name)).isFile());
	} catch (error) {
		errors.push(`scripts directory could not be read: ${error.message}`);
	}
	if (scripts.length === 0) errors.push("no scripts found in scripts/");
	for (const script of scripts) {
		const mode = fs.statSync(path.join(scriptsDir, script)).mode;
		if ((mode & 0o111) === 0) {
			errors.push(`script is not executable: scripts/${script}`);
		}
	}

	return { errors, entrypointCount, scriptCount: scripts.length };
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
	const root = path.resolve(path.dirname(sourcePath), "..");
	const result = validateRepository(root);
	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(`error: ${error}`);
		process.exitCode = 1;
	} else {
		console.log(
			`Manifest valid: versions match, ${result.entrypointCount} entrypoints exist, ${result.scriptCount} scripts are executable.`,
		);
	}
}
