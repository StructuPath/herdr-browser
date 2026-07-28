import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateRepository } from "../scripts/check-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
	const base = fs.mkdtempSync(
		path.join(os.tmpdir(), "herdr-browser-manifest-"),
	);
	const dir = path.join(base, "repository");
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ version: "1.2.3" }),
	);
	fs.writeFileSync(
		path.join(dir, "herdr-plugin.toml"),
		'version = "1.2.3"\n[[actions]]\nid = "open"\ncommand = ["bash", "scripts/open.sh"]\n',
	);
	fs.writeFileSync(path.join(dir, "scripts", "open.sh"), "#!/bin/sh\n", {
		mode: 0o755,
	});
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	return { base, dir };
}

test("repository manifest passes CI validation", () => {
	assert.deepEqual(validateRepository(root).errors, []);
});

test("release version and existing action IDs remain stable", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const manifest = fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8");
	assert.equal(packageJson.version, "0.6.0");
	assert.match(manifest, /^version = "0\.6\.0"$/m);
	assert.deepEqual(
		[...manifest.matchAll(/^id = "([^"]+)"$/gm)].slice(1, 6).map((match) => match[1]),
		["open", "close", "browse", "record-start", "record-stop"],
	);
});

test("manifest validation reports version, entrypoint, and executable-bit failures", (t) => {
	const { dir } = fixture(t);
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ version: "9.9.9" }),
	);
	fs.rmSync(path.join(dir, "scripts", "open.sh"));
	fs.writeFileSync(path.join(dir, "scripts", "other.sh"), "#!/bin/sh\n", {
		mode: 0o644,
	});

	const { errors } = validateRepository(dir);
	assert.ok(errors.some((error) => error.startsWith("version mismatch:")));
	assert.ok(
		errors.some((error) => error.includes("entrypoint does not exist")),
	);
	assert.ok(errors.some((error) => error.includes("script is not executable")));
});

test("manifest validation rejects lexical and symlink repository escapes", (t) => {
	const { base, dir } = fixture(t);
	const outside = path.join(base, "outside.sh");
	fs.writeFileSync(outside, "#!/bin/sh\n", { mode: 0o755 });
	fs.symlinkSync(outside, path.join(dir, "scripts", "linked.sh"));
	fs.writeFileSync(
		path.join(dir, "herdr-plugin.toml"),
		[
			'version = "1.2.3"',
			"[[actions]]",
			'id = "lexical-escape"',
			'command = ["bash", "../outside.sh"]',
			"[[actions]]",
			'id = "symlink-escape"',
			'command = ["bash", "scripts/linked.sh"]',
			"",
		].join("\n"),
	);

	const escapes = validateRepository(dir).errors.filter((error) =>
		error.includes("entrypoint escapes the repository"),
	);
	assert.equal(escapes.length, 2);
});

test("manifest validation reports invalid TOML", (t) => {
	const { dir } = fixture(t);
	fs.writeFileSync(
		path.join(dir, "herdr-plugin.toml"),
		'version = "unterminated\n',
	);

	assert.ok(
		validateRepository(dir).errors.some((error) =>
			error.startsWith("manifest is not valid TOML:"),
		),
	);
});
