// Link-handler pattern tests (U4). The manifest pattern is a Rust-regex; the
// subset used here (no lookaround, no backreferences) behaves identically in
// JS RegExp, so we test the literal pattern extracted from the manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = fs.readFileSync(path.join(repoRoot, 'herdr-plugin.toml'), 'utf8');
const m = manifest.match(/pattern = "((?:[^"\\]|\\.)*)"/);
assert.ok(m, 'pattern found in manifest');
// TOML basic strings escape backslashes: \\ in file -> \ in the regex source.
const pattern = new RegExp(m[1].replace(/\\\\/g, '\\'));

const accepts = [
  'http://localhost:3000',
  'http://localhost:3000/path?q=1',
  'http://localhost:3000?q=1',
  'http://localhost',
  'https://localhost/',
  'https://127.0.0.1:8443',
  'http://[::1]:3000/',
  'http://localhost:3000#section',
];

const rejects = [
  'https://example.com',
  'http://localhost.evil.com',
  'http://localhost.evil.com:3000/',
  'http://localhost@evil.com/',
  'http://user:pass@127.0.0.1/',
  'http://127.0.0.1.evil.com/',
  'ftp://localhost/',
  'http://notlocalhost:3000',
  'javascript:alert(1)',
];

for (const url of accepts) {
  test(`accepts ${url}`, () => assert.ok(pattern.test(url), url));
}
for (const url of rejects) {
  test(`rejects ${url}`, () => assert.ok(!pattern.test(url), url));
}
