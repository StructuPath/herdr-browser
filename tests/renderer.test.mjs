import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveSession, reconcileConsole, consoleTail, pickRenderMode, truncate,
  pngDims, pngComplete, parseSgrMouse, mapClickToPage, sanitizeText, Renderer,
  makeBrowser, pollDelay, safeWsId,
} from '../bin/renderer.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e = texts => texts.map(t => ({ text: t, type: 'log' }));

// A structurally valid 1x1 PNG: signature + IHDR + IEND (CRCs unchecked here).
const PNG_1PX = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  (() => { const b = Buffer.alloc(25); b.writeUInt32BE(13, 0);
    b.writeUInt32BE(0x49484452, 4); b.writeUInt32BE(1, 8); b.writeUInt32BE(1, 12);
    return b; })(),
  (() => { const b = Buffer.alloc(12); b.writeUInt32BE(0x49454e44, 4); return b; })(),
]);

const mkRenderer = (over = {}) => new Renderer({
  HERDR_BROWSER_SESSION: 'hb-test',
  HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hb-r-')),
  HOME: os.homedir(),
  ...over,
});
// Silence painting; keep state transitions observable.
const quiet = r => {
  r.header = () => {}; r.renderConsole = () => {}; r.renderBottom = () => {};
  r.renderImage = async () => {};
  return r;
};
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

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

test('pngDims requires the PNG signature + IHDR, rejects junk', () => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0); // \x89PNG
  buf.writeUInt32BE(0x0d0a1a0a, 4); // \r\n\x1a\n
  buf.writeUInt32BE(0x49484452, 12);
  buf.writeUInt32BE(1280, 16);
  buf.writeUInt32BE(720, 20);
  assert.deepEqual(pngDims(buf), { w: 1280, h: 720 });
  assert.equal(pngDims(Buffer.alloc(10)), null);
  assert.equal(pngDims(Buffer.alloc(24)), null, 'no signature');
  const noSig = Buffer.from(buf); noSig.writeUInt32BE(0, 0);
  assert.equal(pngDims(noSig), null, 'IHDR alone is not a PNG');
});

test('pngComplete requires the terminal IEND chunk', () => {
  assert.equal(pngComplete(PNG_1PX), true);
  assert.equal(pngComplete(PNG_1PX.subarray(0, PNG_1PX.length - 12)), false,
    'truncated frame must not be promoted');
  assert.equal(pngComplete(Buffer.from('not a png at all')), false);
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
  assert.equal(truncate('x', 0), '', 'zero width yields nothing');
  // CJK chars occupy 2 terminal cells: 4 wide chars + ellipsis fill 9 cells
  assert.equal(truncate('日本語日本語', 9), '日本語日…');
  assert.equal(truncate('ab日本語', 5), 'ab日…');
});

test('pollDelay backs off on idle, 8x cap within minutes, 30x floor after ~5 min', () => {
  assert.equal(pollDelay(1000, 0), 1000);
  assert.equal(pollDelay(1000, 9), 1000);
  assert.equal(pollDelay(1000, 10), 2000);
  assert.equal(pollDelay(1000, 30), 4000);
  assert.equal(pollDelay(1000, 60), 8000);
  assert.equal(pollDelay(1000, 299), 8000);
  assert.equal(pollDelay(1000, 300), 30_000);
  assert.equal(pollDelay(1000, 10_000), 30_000);
  // setTimeout's 2^31-1 ceiling: beyond it Node fires after ~1ms (busy loop)
  assert.equal(pollDelay(2 ** 28, 10_000), 2 ** 31 - 1);
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

test('navigate accepts only http(s), banners anything else, never opens it', async () => {
  const r = new Renderer({
    HERDR_BROWSER_SESSION: 'hb-nav',
    HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hb-nav-')),
  });
  const opened = [];
  r.browser = { sessionExists: async () => true, open: async u => opened.push(u) };
  r.header = () => {};
  await r.navigate('example.com');
  await r.navigate('HTTP://caps.example');
  await r.navigate('localhost:3000');
  assert.deepEqual(opened,
    ['https://example.com', 'HTTP://caps.example', 'https://localhost:3000']);
  for (const bad of ['not a url at all //', 'file:///etc/passwd',
    'ftp://host/x', 'javascript:alert(1)']) {
    r.banner = '';
    await r.navigate(bad);
    assert.equal(opened.length, 3, `must not reach the browser: ${bad}`);
    assert.match(r.banner, /not an http\(s\) URL/);
  }
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

// --- Wave 1: security, correctness, reliability regression tests ---

test('safeWsId strips path-unsafe characters, lockstep with bash ws_id', () => {
  assert.equal(safeWsId('w2'), 'w2');
  assert.equal(safeWsId(undefined), 'default');
  assert.equal(safeWsId(''), 'default');
  assert.equal(safeWsId('../../victim'), 'victim');
  assert.equal(safeWsId('!!!'), 'default');
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR')));
  for (const id of ['w2', '../../victim', 'a b/c', '!!!', 'w-1_x']) {
    const sh = execFileSync('bash', ['-c',
      `. "${repoRoot}/scripts/lib.sh" && HERDR_WORKSPACE_ID="$1" ws_id`, '--', id],
      { env: cleanEnv }).toString().trim();
    assert.equal(safeWsId(id), sh, `lockstep for ${JSON.stringify(id)}`);
  }
});

test('deriveSession strips control chars from every source', () => {
  // ESC/BEL introducers are stripped; the inert printable payload remains.
  assert.equal(deriveSession({ HERDR_BROWSER_SESSION: 'x\x1b]52;c;AAAA\x07y' }, '/'),
    'x]52;c;AAAAy');
  assert.equal(deriveSession({ HERDR_BROWSER_SESSION: '   ' }, '/').startsWith('herdr-cwd-'), true,
    'all-whitespace env session falls through');
  assert.equal(deriveSession({ HERDR_WORKSPACE_ID: '../../victim' }, '/'), 'herdr-ws-victim');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cfg-'));
  fs.writeFileSync(path.join(tmp, 'session'), 'evil\x1b[2Jsess\n');
  assert.equal(deriveSession({ HERDR_PLUGIN_CONFIG_DIR: tmp }, '/'), 'evil[2Jsess');
});

test('session_name env branch strips control chars, lockstep with JS', () => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR')));
  const sh = execFileSync('bash', ['-c',
    `. "${repoRoot}/scripts/lib.sh" && HERDR_BROWSER_SESSION="$1" session_name`,
    '--', 'x\x1b]52;c;AAAA\x07y z'], { env: cleanEnv }).toString().trim();
  assert.equal(sh, 'x]52;c;AAAAyz');
  assert.equal(sh, deriveSession({ HERDR_BROWSER_SESSION: 'x\x1b]52;c;AAAA\x07y z' }, '/'));
});

test('state_dir expands a literal leading tilde (no per-cwd ./~ tree)', () => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR')));
  const sh = execFileSync('bash', ['-c',
    `. "${repoRoot}/scripts/lib.sh" && HERDR_PLUGIN_STATE_DIR='~/.local/state/hb-tilde-test' state_dir`],
    { env: cleanEnv }).toString().trim();
  assert.equal(sh, `${os.homedir()}/.local/state/hb-tilde-test`);
  fs.rmSync(`${os.homedir()}/.local/state/hb-tilde-test`, { recursive: true, force: true });
});

test('Renderer constructor expands tilde state dir and falls back on relative', () => {
  const r1 = mkRenderer({ HERDR_PLUGIN_STATE_DIR: '~/.local/state/hb-tilde-js' });
  assert.equal(r1.stateDir, `${os.homedir()}/.local/state/hb-tilde-js`);
  fs.rmSync(r1.stateDir, { recursive: true, force: true });
  const r2 = mkRenderer({ HERDR_PLUGIN_STATE_DIR: 'relative/dir' });
  assert.equal(r2.stateDir, path.join(os.homedir(), '.local/state/herdr-browser'));
});

test('sanitizeText strips bidi/zero-width spoofing chars', () => {
  assert.equal(sanitizeText('https://good.com\u202E/moc.live//:sptth'), 'https://good.com/moc.live//:sptth');
  assert.equal(sanitizeText('a\u200Bb\u200Ec\ufeffd'), 'abcd');
});

test('intervalMs is clamped at the top: no setTimeout overflow busy-loop', () => {
  const mk = v => mkRenderer({ HERDR_BROWSER_INTERVAL_MS: v }).intervalMs;
  assert.equal(mk('Infinity'), 86_400_000);
  assert.equal(mk('999999999999'), 86_400_000);
});

test('tick stays passive when the session is missing', async () => {
  const r = quiet(mkRenderer());
  r.agentBrowser = true;
  const calls = [];
  r.browser = {
    sessionExists: async () => { calls.push('sessionExists'); return false; },
    url: async () => { calls.push('url'); return ''; },
    title: async () => { calls.push('title'); return ''; },
    console: async () => { calls.push('console'); return []; },
    screenshot: async () => { calls.push('screenshot'); },
  };
  await r.tick();
  assert.deepEqual(calls, ['sessionExists'],
    'get/console/screenshot would auto-create a headless Chrome — never call them unattached');
  assert.match(r.banner, /waiting for session/);
});

test('tick banner names the real problem when agent-browser is not installed', async () => {
  const r = quiet(mkRenderer());
  r.agentBrowser = false;
  r.browser = { sessionExists: async () => false };
  await r.tick();
  assert.match(r.banner, /not installed/);
  assert.match(r.banner, /npm install -g agent-browser/);
});

test('tick failure lifecycle: banner, detach, ownership dies with the session', async () => {
  const r = quiet(mkRenderer());
  r.attached = true;
  r.selfCreated = true;
  let exists = true;
  r.browser = {
    url: async () => { throw new Error('wedged'); },
    title: async () => { throw new Error('wedged'); },
    console: async () => { throw new Error('wedged'); },
    screenshot: async () => { throw new Error('wedged'); },
    sessionExists: async () => exists,
  };
  await r.tick(); await r.tick();
  assert.equal(r.attached, true);
  await r.tick();
  assert.match(r.banner, /not responding/);
  exists = false;
  await r.tick();
  assert.equal(r.attached, false, 'detaches when the session is gone');
  assert.equal(r.selfCreated, false, 'ownership must not survive the session that granted it');
  assert.match(r.banner, /session .* ended/);
});

test('tick promotes only changed, complete frames', async () => {
  const r = quiet(mkRenderer());
  let renders = 0;
  r.renderImage = async () => { renders++; };
  let shot = PNG_1PX;
  r.browser = {
    url: async () => 'https://x', title: async () => 't', console: async () => [],
    screenshot: async f => { fs.writeFileSync(f, shot); },
    sessionExists: async () => true,
  };
  await r.tick();
  assert.equal(renders, 1, 'first frame rendered');
  assert.equal(fs.readFileSync(r.shot).equals(PNG_1PX), true, 'frame promoted');
  assert.equal(fs.readdirSync(r.stateDir).filter(f => f.includes('.tmp')).length, 0,
    'tmp cleaned up');
  await r.tick();
  assert.equal(renders, 1, 'identical frame skipped');
  const other = Buffer.concat([PNG_1PX.subarray(0, 16), Buffer.from([2]), PNG_1PX.subarray(17)]);
  shot = other;
  await r.tick();
  assert.equal(renders, 2, 'changed frame rendered');
  shot = Buffer.from('garbage not a png');
  await r.tick();
  assert.equal(r.failures, 1, 'corrupt frame counts as a tick failure');
  assert.equal(fs.readFileSync(r.shot).equals(other), true, 'corrupt frame never promoted');
});

test('navigate rejects userinfo and scheme-less junk', async () => {
  const r = quiet(mkRenderer());
  const opened = [];
  r.browser = { sessionExists: async () => true, open: async u => opened.push(u) };
  for (const bad of ['mailto:user@example.com', 'foo@bar.com', 'user:pass@evil.com',
    'http://user@localhost:3000/', '-rf']) {
    r.banner = '';
    await r.navigate(bad);
    assert.equal(opened.length, 0, `must not open: ${bad}`);
    assert.match(r.banner, /not an http\(s\) URL/, bad);
  }
  await r.navigate('http://localhost:3000/@weird-path');
  assert.deepEqual(opened, ['http://localhost:3000/@weird-path'],
    '@ in the path is not credentials');
});

test('navigate does not claim ownership when open fails', async () => {
  const r = quiet(mkRenderer());
  r.browser = {
    sessionExists: async () => false,
    open: async () => { throw new Error('daemon down'); },
  };
  await assert.rejects(r.navigate('example.com'));
  assert.equal(r.selfCreated, false,
    'a failed open must never own a session it did not create');
});

test('URL policy lockstep: bash validate_url and JS navigate agree on scheme-ful input', async () => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR')));
  const bash = u => spawnSync('bash', ['-c',
    `. "${repoRoot}/scripts/lib.sh" && validate_url "$1"`, '--', u],
    { env: cleanEnv }).status === 0;
  const r = quiet(mkRenderer());
  const opened = [];
  r.browser = { sessionExists: async () => true, open: async u => opened.push(u) };
  const js = async u => {
    const before = opened.length;
    await r.navigate(u);
    return opened.length > before;
  };
  for (const [u, verdict] of [
    ['http://example.com', true],
    ['HTTP://caps.example', true],
    ['https://127.0.0.1:8443/x?y#z', true],
    ['http://localhost:3000/@path', true],
    ['file:///etc/passwd', false],
    ['ftp://host/x', false],
    ['javascript:alert(1)', false],
    ['-rf', false],
    ['http://user@host/', false],
    ['https://user:pass@host/', false],
  ]) {
    assert.equal(await js(u), verdict, `JS navigate: ${u}`);
    assert.equal(bash(u), verdict, `bash validate_url: ${u}`);
  }
});

test('clickAt maps in-image clicks and ignores out-of-image clicks', async () => {
  const r = quiet(mkRenderer());
  r.size = () => ({ cols: 100, rows: 37, imageRows: 30, consoleRows: 7, imageTopRow: 3, bottomRow: 37 });
  fs.writeFileSync(r.shot, PNG_1PX);
  const evals = [];
  r.browser = { eval: async js => evals.push(js) };
  await r.clickAt(1, 1);
  await r.clickAt(1, 33);
  await r.clickAt(1, 36);
  assert.equal(evals.length, 0, 'header/console rows never eval into the page');
  fs.rmSync(r.shot);
  await r.clickAt(5, 10);
  assert.equal(evals.length, 0, 'missing screenshot never evals');
  fs.writeFileSync(r.shot, 'junk');
  await r.clickAt(5, 10);
  assert.equal(evals.length, 0, 'corrupt screenshot never evals');
  fs.writeFileSync(r.shot, PNG_1PX);
  await r.clickAt(1, 3);
  assert.equal(evals.length, 1);
  assert.match(evals[0], /elementFromPoint\(\d+, \d+\)/);
});

test('cleanup closes only self-created sessions and removes shot files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-close-'));
  const stub = path.join(dir, 'ab-stub');
  const logf = path.join(dir, 'log');
  fs.writeFileSync(stub,
    `#!/usr/bin/env bash\necho "$@" >> "${logf}"\n`);
  fs.chmodSync(stub, 0o755);
  const mk = () => quiet(mkRenderer());
  const own = mk();
  own.bin = stub;
  own.selfCreated = true;
  fs.writeFileSync(own.shot, 'x');
  own.cleanup();
  assert.match(fs.readFileSync(logf, 'utf8'), /--session hb-test close/);
  assert.equal(fs.existsSync(own.shot), false);
  fs.writeFileSync(logf, '');
  const foreign = mk();
  foreign.bin = stub;
  foreign.selfCreated = false;
  foreign.cleanup();
  assert.equal(fs.readFileSync(logf, 'utf8'), '', 'agent-owned session must survive pane quit');
});

test('promptInput submits trimmed, cancels, edits, refuses C1, keeps UTF-8', async () => {
  const r = quiet(mkRenderer());
  r.browser = { sessionExists: async () => false };
  const submits = [];
  r.openPrompt('URL: ', v => submits.push(v));
  r.promptInput('  example.com  \r');
  await flush();
  assert.deepEqual(submits, ['example.com']);
  assert.equal(r.promptState, null);

  r.openPrompt('URL: ', v => submits.push(v));
  r.promptInput('   \r'); // whitespace-only never submits
  await flush();
  assert.equal(submits.length, 1);
  assert.equal(r.promptState, null);

  r.openPrompt('URL: ', v => submits.push(v));
  r.promptInput('ab\x1b');
  assert.equal(r.promptState, null, 'esc cancels');

  r.openPrompt('URL: ', v => submits.push(v));
  r.promptInput('ab\x7fc');
  assert.equal(r.promptState.value, 'ac', 'backspace edits');
  r.promptInput('\x9b');
  assert.equal(r.promptState.value, 'ac', 'C1 control bytes refused');
  r.promptInput('é漢');
  assert.equal(r.promptState.value, 'acé漢', 'multibyte input survives');
  r.promptInput('\r');
  await flush();
  assert.deepEqual(submits, ['example.com', 'acé漢']);
});

test('prompt mode swallows mouse reports without cancelling', () => {
  const r = quiet(mkRenderer());
  r.openPrompt('URL: ', () => {});
  r.promptInput('ab\x1b[<0;40;10Mcd');
  assert.notEqual(r.promptState, null, 'click did not cancel the prompt');
  assert.equal(r.promptState.value, 'abcd', 'report bytes never enter the value');
});

test('onInput gates keys and clicks while unattached', async () => {
  const r = quiet(mkRenderer());
  const calls = [];
  r.browser = new Proxy({}, { get: () => async () => calls.push('call') });
  r.onInput('b'); r.onInput('r'); r.onInput('j');
  r.onInput('\x1b[<0;10;5M');
  await flush();
  assert.equal(calls.length, 0, 'unattached pane ignores drive keys and clicks');
  r.onInput('u');
  assert.notEqual(r.promptState, null, 'u always opens the address bar');
});

test('pushConsole prefixes, sanitizes display, caps at 500', () => {
  const r = quiet(mkRenderer());
  r.pushConsole([{ text: 'boom\x1b[2J', type: 'error' }, { text: 'careful', type: 'warn' },
    { text: 'hi', type: 'log' }], false);
  assert.equal(r.consoleLines[0], '✖ boom[2J');
  assert.equal(r.consoleLines[1], '⚠ careful');
  assert.equal(r.consoleLines[2], '  hi');
  for (let i = 0; i < 600; i++) r.pushConsole([{ text: `line${i}`, type: 'log' }], false);
  assert.equal(r.consoleLines.length, 500, 'display buffer capped');
  assert.equal(r.consolePushes, 603, 'monotonic counter survives the cap (sig/backoff depend on it)');
});

test('enqueue counts paint failures instead of silently swallowing them', async () => {
  const r = quiet(mkRenderer());
  await r.enqueue(() => { throw new Error('paint bug'); });
  assert.equal(r.paintErrors, 1);
  await r.enqueue(() => {});
  assert.equal(r.paintErrors, 1, 'queue is not poisoned by a throw');
});

test('reconcile edge matrix: empty tail, ring boundary, duplicate texts', () => {
  // Empty tail below the ring aligns vacuously on the head: suffix is new.
  const r1 = reconcileConsole({ count: 3, tail: [] }, e(['a', 'b', 'c', 'd']));
  assert.deepEqual(r1.newEntries.map(x => x.text), ['d']);
  assert.equal(r1.marker, false);
  // Empty tail at ring size cannot align: discontinuity marker + full set.
  const r1b = reconcileConsole({ count: 1000, tail: [] }, e(['a', 'b']));
  assert.equal(r1b.marker, true);
  const r2 = reconcileConsole({ count: 5, tail: ['d', 'e'] }, e(['a', 'b', 'c', 'd', 'e']), 5);
  assert.deepEqual(r2.newEntries.length, 0);
  assert.equal(r2.marker, false, 'no rotation at the boundary');
  const r3 = reconcileConsole({ count: 2, tail: ['x', 'x'] }, e(['x', 'x', 'x', 'x']), 1000);
  assert.deepEqual(r3.newEntries.map(x => x.text), ['x', 'x']);
});
