import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveSession, reconcileConsole, consoleTail, pickRenderMode, truncate,
  pngDims, parseSgrMouse, mapClickToPage, sanitizeText, Renderer, makeBrowser,
  pollDelay,
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

test('deriveSession config parsing matches bash: strips inner whitespace, skips empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cfg-'));
  fs.writeFileSync(path.join(tmp, 'session'), 'my session\n');
  assert.equal(deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp }, '/'), 'mysession');
  fs.writeFileSync(path.join(tmp, 'session'), '\n');
  assert.equal(
    deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp, HERDR_WORKSPACE_ID: 'w2' }, '/'),
    'herdr-ws-w2');
});

test('deriveSession cwd fallback survives shell metacharacters in path', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-meta-')));
  const cwd = path.join(base, 'proj$HOME"x');
  fs.mkdirSync(cwd);
  const js = deriveSession({}, cwd);
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR')));
  const sh = execFileSync(
    'bash', ['-c', `. "${repoRoot}/scripts/lib.sh" && session_name`],
    { cwd, env: cleanEnv },
  ).toString().trim();
  assert.equal(js, sh);
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

test('pngDims parses IHDR width/height, rejects junk', () => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x49484452, 12);
  buf.writeUInt32BE(1280, 16);
  buf.writeUInt32BE(720, 20);
  assert.deepEqual(pngDims(buf), { w: 1280, h: 720 });
  assert.equal(pngDims(Buffer.alloc(10)), null);
  assert.equal(pngDims(Buffer.alloc(24)), null);
});

test('parseSgrMouse parses press and release', () => {
  assert.deepEqual(parseSgrMouse('\x1b[<0;40;10M'),
    { button: 0, col: 40, row: 10, release: false });
  assert.equal(parseSgrMouse('\x1b[<0;40;10m').release, true);
  assert.equal(parseSgrMouse('u'), null);
});

test('mapClickToPage maps clicks and respects letterboxing', () => {
  const geom = { cols: 100, imageRows: 30, imageTopRow: 3, pngW: 1280, pngH: 720 };
  // scale = min(100/1280, 60/720) = 0.078125; click at col 50, row 17
  assert.deepEqual(mapClickToPage(50, 17, geom), { x: 634, y: 371 });
  // drawn height is 56.25 half-cell units; row 31 => unitY 57 falls below the image
  assert.equal(mapClickToPage(50, 31, geom), null);
  assert.equal(mapClickToPage(50, 2, geom), null);
});

test('truncate', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w…');
});

test('pollDelay backs off on idle and caps at 8x', () => {
  assert.equal(pollDelay(1000, 0), 1000);
  assert.equal(pollDelay(1000, 9), 1000);
  assert.equal(pollDelay(1000, 10), 2000);
  assert.equal(pollDelay(1000, 30), 4000);
  assert.equal(pollDelay(1000, 60), 8000);
  assert.equal(pollDelay(1000, 10_000), 8000);
});

test('intervalMs is clamped: no busy-loop from tiny/negative/garbage values', () => {
  const mk = v => new Renderer({
    HERDR_BROWSER_INTERVAL_MS: v,
    HERDR_BROWSER_SESSION: 'hb-clamp',
    HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hb-clamp-')),
  }).intervalMs;
  assert.equal(mk('-5'), 250);
  assert.equal(mk('100'), 250);
  assert.equal(mk('abc'), 1000);
  assert.equal(mk(undefined), 1000);
  assert.equal(mk('2000'), 2000);
});

test('sessionExists requires an exact session-name match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sess-'));
  const stub = path.join(dir, 'ab-stub');
  fs.writeFileSync(stub,
    '#!/usr/bin/env bash\necho \'{"success":true,"data":{"sessions":["herdr-ws-w22","other"]}}\'\n');
  fs.chmodSync(stub, 0o755);
  assert.equal(await makeBrowser('herdr-ws-w2', stub).sessionExists(), false,
    'substring of a listed session must not count');
  assert.equal(await makeBrowser('herdr-ws-w22', stub).sessionExists(), true);
  assert.equal(await makeBrowser('other', stub).sessionExists(), true);
});

test('navigate claims session ownership only when it creates the session', async () => {
  const mk = () => new Renderer({
    HERDR_BROWSER_SESSION: 'hb-unit',
    HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hb-own-')),
  });
  const fresh = mk();
  fresh.browser = { sessionExists: async () => false, open: async () => {} };
  await fresh.navigate('example.com');
  assert.equal(fresh.selfCreated, true, 'pane created it: pane owns it');

  const attached = mk();
  attached.browser = { sessionExists: async () => true, open: async () => {} };
  await attached.navigate('example.com');
  assert.equal(attached.selfCreated, false, 'agent created it: never ours');
});

test('sanitizeText strips escape sequences and control chars from page text', () => {
  assert.equal(sanitizeText('\x1b]0;PWNED\x07evil\x1b[2J'), ']0;PWNEDevil[2J');
  assert.equal(sanitizeText('\x1b_Ga=T\x1b\\x'), '_Ga=T\\x');
  assert.equal(sanitizeText('a\tb\r\nc\x7f\u009bd'), 'a bcd');
  assert.equal(sanitizeText('plain — unicode ✓ stays'), 'plain — unicode ✓ stays');
  assert.equal(sanitizeText(123), '123');
});
