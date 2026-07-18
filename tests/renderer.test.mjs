import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveSession, reconcileConsole, consoleTail, pickRenderMode, truncate,
} from '../bin/renderer.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e = texts => texts.map(t => ({ text: t, type: 'log' }));

test('reconcile: first poll returns everything', () => {
  const r = reconcileConsole({ count: 0, tail: [] }, e(['a', 'b']));
  assert.deepEqual(r.newEntries.map(x => x.text), ['a', 'b']);
  assert.equal(r.marker, false);
});

test('reconcile: plain append below ring size', () => {
  const r = reconcileConsole({ count: 2, tail: ['a', 'b'] }, e(['a', 'b', 'c']));
  assert.deepEqual(r.newEntries.map(x => x.text), ['c']);
  assert.equal(r.marker, false);
});

test('reconcile: external clear shrinks buffer -> marker', () => {
  const r = reconcileConsole({ count: 5, tail: ['d', 'e'] }, e(['x', 'y']));
  assert.deepEqual(r.newEntries.map(x => x.text), ['x', 'y']);
  assert.equal(r.marker, true);
});

test('reconcile: saturated ring rotation with partial tail survival', () => {
  // ring of 5: buffer was [a..e], now [d..h] — 'c' from our tail was evicted
  const prev = { count: 5, tail: ['c', 'd', 'e'] };
  const r = reconcileConsole(prev, e(['d', 'e', 'f', 'g', 'h']), 5);
  assert.deepEqual(r.newEntries.map(x => x.text), ['f', 'g', 'h']);
  assert.equal(r.marker, false);
});

test('reconcile: rotation evicted entire tail -> marker + full set', () => {
  const prev = { count: 5, tail: ['x', 'y', 'z'] };
  const r = reconcileConsole(prev, e(['d', 'e', 'f', 'g', 'h']), 5);
  assert.equal(r.marker, true);
  assert.equal(r.newEntries.length, 5);
});

test('consoleTail keeps last n texts', () => {
  assert.deepEqual(consoleTail(e(['a', 'b', 'c']), 2), ['b', 'c']);
});

test('pickRenderMode precedence', () => {
  assert.equal(pickRenderMode({ HERDR_BROWSER_RENDER: 'text' }, undefined, 'Gi=31;OK', true), 'text');
  assert.equal(pickRenderMode({}, 'kitty', '', true), 'kitty');
  assert.equal(pickRenderMode({}, undefined, '\x1b_Gi=31;OK\x1b\\\x1b[?62c', true), 'kitty');
  assert.equal(pickRenderMode({}, undefined, '\x1b[?62c', true), 'symbols');
  assert.equal(pickRenderMode({}, undefined, '', true), 'symbols');
  assert.equal(pickRenderMode({}, undefined, 'Gi=31;OK', false), 'text');
});

test('deriveSession precedence: env > config > workspace > cwd', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  fs.writeFileSync(path.join(tmp, 'session'), 'my-session\n');
  assert.equal(deriveSession({ HERDR_BROWSER_SESSION: 'ov' }, '/'), 'ov');
  assert.equal(deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp }, '/'), 'my-session');
  assert.equal(deriveSession({ HERDR_WORKSPACE_ID: 'w2' }, '/'), 'herdr-ws-w2');
  assert.match(deriveSession({}, '/some/dir'), /^herdr-cwd-\d+$/);
});

test('deriveSession cwd fallback matches bash session_name()', () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-lockstep-')));
  const js = deriveSession({}, cwd);
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR')));
  const sh = execFileSync(
    'bash', ['-c', `. "${repoRoot}/scripts/lib.sh" && session_name`],
    { cwd, env: cleanEnv },
  ).toString().trim();
  assert.equal(js, sh);
});

test('truncate', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w…');
});
