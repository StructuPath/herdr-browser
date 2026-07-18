#!/usr/bin/env node
// herdr-browser pane renderer: a passive viewer of an agent-browser session.
// It never navigates, never clears the console buffer, and never creates or
// destroys the browser session — those belong to the user and their agent.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const pExecFile = promisify(execFile);
const ESC = '\x1b';
const KITTY_DELETE = `${ESC}_Ga=d,d=A${ESC}\\`;

// --- pure helpers (unit-tested) ---

// Must stay in lockstep with session_name() in scripts/lib.sh.
export function deriveSession(env, cwd) {
  if (env.HERDR_BROWSER_SESSION) return env.HERDR_BROWSER_SESSION;
  if (env.HERDR_PLUGIN_CONFIG_DIR) {
    const f = path.join(env.HERDR_PLUGIN_CONFIG_DIR, 'session');
    if (fs.existsSync(f)) {
      const name = fs.readFileSync(f, 'utf8').split('\n')[0].replace(/\s/g, '');
      if (name) return name;
    }
  }
  if (env.HERDR_WORKSPACE_ID) return `herdr-ws-${env.HERDR_WORKSPACE_ID}`;
  const sum = spawnSync('sh', ['-c', "printf '%s\\n' \"$HB_CWD\" | cksum"],
    { env: { ...process.env, HB_CWD: cwd } }).stdout.toString().split(' ')[0];
  return `herdr-cwd-${sum}`;
}

// Console cursor reconciliation over agent-browser's 1000-entry ring buffer.
// prev: { count, tail } where tail is the last few entry texts we rendered.
// Returns { newEntries, marker } — marker signals an external clear or a
// rotation we could not align, so callers should show a discontinuity note.
export function reconcileConsole(prev, entries, ringSize = 1000) {
  if (!prev || prev.count === 0) return { newEntries: entries, marker: false };
  if (entries.length < prev.count) return { newEntries: entries, marker: true };
  if (prev.count < ringSize && entries.length >= prev.count) {
    const head = entries.slice(0, prev.count).map(e => e.text);
    const aligned = prev.tail.every(
      (t, i) => head[prev.count - prev.tail.length + i] === t,
    );
    if (aligned) return { newEntries: entries.slice(prev.count), marker: false };
  }
  // Ring saturated (or head mismatch): find the latest occurrence of our tail
  // window in the new buffer and take what follows it. Rotation may have
  // evicted the window's head, so retry with progressively shorter suffixes.
  const texts = entries.map(e => e.text);
  for (let winLen = prev.tail.length; winLen >= 1; winLen--) {
    const win = prev.tail.slice(prev.tail.length - winLen);
    for (let end = texts.length - 1; end >= winLen - 1; end--) {
      let match = true;
      for (let i = 0; i < winLen; i++) {
        if (texts[end - winLen + 1 + i] !== win[i]) { match = false; break; }
      }
      if (match) return { newEntries: entries.slice(end + 1), marker: false };
    }
  }
  return { newEntries: entries, marker: true };
}

export function consoleTail(entries, n = 8) {
  return entries.slice(-n).map(e => e.text);
}

// Render-mode precedence: explicit config > kitty probe > symbols.
// probeResponse is the raw bytes the terminal answered to a kitty graphics
// query; empty/undefined means no answer (not supported).
export function pickRenderMode(env, configDirValue, probeResponse, chafaAvailable) {
  const explicit = env.HERDR_BROWSER_RENDER || configDirValue;
  if (explicit && ['kitty', 'symbols', 'text'].includes(explicit)) return explicit;
  if (!chafaAvailable) return 'text';
  if (probeResponse && probeResponse.includes('Gi=31;OK')) return 'kitty';
  return 'symbols';
}

export function truncate(s, width) {
  return s.length <= width ? s : s.slice(0, Math.max(0, width - 1)) + '…';
}

export function pngDims(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null; // IHDR
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// SGR mouse report: ESC [ < button ; col ; row (M=press, m=release)
export function parseSgrMouse(s) {
  const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
  if (!m) return null;
  return { button: Number(m[1]), col: Number(m[2]), row: Number(m[3]), release: m[4] === 'm' };
}

// Map a terminal cell click inside the image region to page pixel
// coordinates. chafa draws top-left into a cols x imageRows box preserving
// pixel aspect with a ~1:2 cell width:height ratio; work in half-cell units.
export function mapClickToPage(col, row, { cols, imageRows, imageTopRow, pngW, pngH }) {
  if (!pngW || !pngH || imageRows <= 0) return null;
  const unitX = (col - 1) + 0.5;
  const unitY = (row - imageTopRow) * 2 + 1;
  if (unitY < 0) return null;
  const scale = Math.min(cols / pngW, (imageRows * 2) / pngH);
  if (!(scale > 0)) return null;
  if (unitX > pngW * scale || unitY > pngH * scale) return null;
  return { x: Math.round(unitX / scale), y: Math.round(unitY / scale) };
}

// --- agent-browser access ---

function makeBrowser(session, bin = 'agent-browser') {
  const run = async (...args) => {
    const { stdout } = await pExecFile(
      bin, ['--session', session, ...args, '--json'], { timeout: 10_000 });
    const parsed = JSON.parse(stdout);
    if (parsed.success === false) throw new Error(parsed.error || 'agent-browser error');
    return parsed.data;
  };
  return {
    url: async () => (await run('get', 'url')).url,
    title: async () => (await run('get', 'title')).title ?? '',
    console: async () => {
      const d = await run('console');
      return Array.isArray(d) ? d : (d.messages ?? []);
    },
    screenshot: async file => { await run('screenshot', file); },
    open: async u => { await run('open', u); },
    back: async () => { await run('back'); },
    forward: async () => { await run('forward'); },
    reload: async () => { await run('reload'); },
    scroll: async (dir, px) => { await run('scroll', dir, String(px)); },
    type: async text => { await run('type', text); },
    eval: async js => { await run('eval', js); },
    sessionExists: async () => {
      try {
        const { stdout } = await pExecFile(
          bin, ['session', 'list', '--json'], { timeout: 10_000 });
        return stdout.includes(session);
      } catch { return false; }
    },
  };
}

// --- renderer main ---

class Renderer {
  constructor(env = process.env) {
    this.env = env;
    this.session = deriveSession(env, process.cwd());
    this.stateDir = env.HERDR_PLUGIN_STATE_DIR
      || path.join(env.HOME || '.', '.local/state/herdr-browser');
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.chmodSync(this.stateDir, 0o700);
    this.shot = path.join(this.stateDir, `shot-${env.HERDR_WORKSPACE_ID || 'default'}.png`);
    this.browser = makeBrowser(this.session);
    this.chafa = spawnSync('sh', ['-c', 'command -v chafa']).status === 0;
    this.intervalMs = Number(env.HERDR_BROWSER_INTERVAL_MS) || 1000;
    this.lastHash = '';
    this.lastUrl = '';
    this.lastTitle = '';
    this.consoleState = { count: 0, tail: [] };
    this.consoleLines = [];
    this.failures = 0;
    this.banner = '';
    this.attached = false;
    this.promptState = null;
    this.paintQueue = Promise.resolve();
  }

  // Serialize all screen-writing work: ticks and resize redraws must never
  // interleave their stdout escape sequences.
  enqueue(fn) {
    this.paintQueue = this.paintQueue.then(fn, () => {});
    return this.paintQueue;
  }

  size() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const consoleRows = this.mode === 'text' ? rows - 3 : Math.max(4, Math.floor(rows * 0.3));
    const imageRows = this.mode === 'text' ? 0 : rows - consoleRows - 4;
    return { cols, rows, imageRows, consoleRows, imageTopRow: 3, bottomRow: rows };
  }

  configValue(name) {
    const dir = this.env.HERDR_PLUGIN_CONFIG_DIR;
    if (!dir) return undefined;
    const f = path.join(dir, name);
    try { return fs.readFileSync(f, 'utf8').split('\n')[0].trim() || undefined; }
    catch { return undefined; }
  }

  header() {
    const { cols } = this.size();
    const line1 = truncate(
      ` herdr-browser  session:${this.session}  mode:${this.mode}`, cols);
    const blankHint = this.lastUrl === 'about:blank' ? '  (nothing loaded yet)' : '';
    const line2 = this.banner
      ? truncate(` ! ${this.banner}`, cols)
      : truncate(` ${this.lastUrl}${this.lastTitle ? '  —  ' + this.lastTitle : ''}${blankHint}`, cols);
    process.stdout.write(`${ESC}[1;1H${ESC}[7m${line1}${ESC}[K${ESC}[0m`);
    process.stdout.write(`${ESC}[2;1H${line2}${ESC}[K`);
    this.renderBottom();
  }

  renderBottom() {
    const { cols, bottomRow } = this.size();
    if (this.promptState) {
      const text = ` ${this.promptState.label}${this.promptState.value}█`;
      process.stdout.write(`${ESC}[${bottomRow};1H${truncate(text, cols)}${ESC}[K`);
    } else {
      const help = ' u:url  click:page  i:type  b/f:back-fwd  r:reload  j/k:scroll  q:quit';
      process.stdout.write(`${ESC}[${bottomRow};1H${ESC}[2m${truncate(help, cols)}${ESC}[K${ESC}[0m`);
    }
  }

  async renderImage() {
    const { cols, imageRows } = this.size();
    if (this.mode === 'text' || imageRows < 3 || !fs.existsSync(this.shot)) return;
    const fmt = this.mode === 'kitty' ? 'kitty' : 'symbols';
    try {
      const { stdout } = await pExecFile(
        'chafa', ['-f', fmt, '-s', `${cols}x${imageRows}`, '--animate', 'off', '--probe', 'off', this.shot],
        { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
      );
      if (this.mode === 'kitty') process.stdout.write(KITTY_DELETE);
      process.stdout.write(`${ESC}[3;1H`);
      process.stdout.write(stdout);
    } catch { /* chafa hiccup: keep previous frame */ }
  }

  renderConsole() {
    const { cols, rows, consoleRows } = this.size();
    const top = rows - consoleRows;
    process.stdout.write(`${ESC}[${top};1H${'─'.repeat(cols)}`);
    const lines = this.consoleLines.slice(-(consoleRows - 1));
    for (let i = 0; i < consoleRows - 1; i++) {
      const text = lines[i] ? truncate(lines[i], cols) : '';
      process.stdout.write(`${ESC}[${top + 1 + i};1H${text}${ESC}[K`);
    }
  }

  pushConsole(entries, marker) {
    if (marker) this.consoleLines.push('— console cleared or rotated —');
    for (const e of entries) {
      const prefix = e.type === 'error' ? '✖ '
        : (e.type === 'warn' || e.type === 'warning') ? '⚠ ' : '  ';
      this.consoleLines.push(prefix + (e.text ?? ''));
    }
    if (this.consoleLines.length > 500) {
      this.consoleLines = this.consoleLines.slice(-500);
    }
  }

  async tick() {
    // Stay truly passive: any get/console/screenshot call would auto-create
    // the session (and a headless Chrome) on the daemon. Until the session
    // exists — created by an agent, a link click, or a URL-bearing open —
    // only run the non-creating existence check and wait.
    if (!this.attached) {
      if (!(await this.browser.sessionExists())) {
        this.banner = `waiting for session "${this.session}" — Cmd+click a localhost link or have your agent use --session ${this.session}`;
        this.header();
        return;
      }
      this.attached = true;
      this.banner = '';
    }
    let failed = false;
    try {
      const [url, title, entries] = await Promise.all([
        this.browser.url(), this.browser.title(), this.browser.console(),
      ]);
      this.lastUrl = url;
      this.lastTitle = title;
      const { newEntries, marker } = reconcileConsole(this.consoleState, entries);
      if (newEntries.length || marker) {
        this.pushConsole(newEntries, marker);
        this.renderConsole();
      }
      this.consoleState = { count: entries.length, tail: consoleTail(entries) };

      const tmp = this.shot + '.tmp';
      await this.browser.screenshot(tmp);
      const hash = createHash('md5').update(fs.readFileSync(tmp)).digest('hex');
      if (hash !== this.lastHash) {
        fs.renameSync(tmp, this.shot);
        fs.chmodSync(this.shot, 0o600);
        this.lastHash = hash;
        await this.renderImage();
      } else {
        fs.unlinkSync(tmp);
      }
      this.banner = '';
      this.failures = 0;
    } catch {
      failed = true;
      this.failures++;
    }
    if (failed && this.failures >= 3) {
      if (await this.browser.sessionExists()) {
        this.banner = 'agent-browser not responding — retrying';
      } else {
        this.attached = false;
        this.failures = 0;
        this.banner = `session "${this.session}" ended — waiting for it to come back`;
      }
    }
    this.header();
  }

  // One permanent stdin pipeline: raw mode is set once and stdin is never
  // paused. During the startup probe, bytes route to the probe sink; after
  // that, to the interactive handler. (Toggling raw mode + pause/resume
  // around a temporary listener silently kills later delivery.)
  dbg(m) {
    if (this.env.HB_DEBUG_INPUT) fs.appendFileSync(this.env.HB_DEBUG_INPUT, m + '\n');
  }

  setupInput() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', chunk => {
      const s = chunk.toString('latin1');
      if (this.env.HB_DEBUG_INPUT) {
        fs.appendFileSync(this.env.HB_DEBUG_INPUT,
          `data sink=${!!this.probeSink} s=${JSON.stringify(s)}\n`);
      }
      if (this.probeSink) this.probeSink(s);
      else this.onInput(s);
    });
  }

  // DA1 response terminates the probe: every terminal answers ESC [ ? ... c
  probeKitty(timeoutMs = 300) {
    return new Promise(resolve => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve('');
      let buf = '';
      const timer = setTimeout(() => { this.probeSink = null; resolve(buf); }, timeoutMs);
      this.probeSink = s => {
        buf += s;
        if (/\x1b\[\?[\d;]*c/.test(buf)) {
          clearTimeout(timer);
          this.probeSink = null;
          resolve(buf);
        }
      };
      process.stdout.write(`${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`);
    });
  }

  onInput(s) {
    const mouse = parseSgrMouse(s);
    if (mouse) {
      if (!mouse.release && mouse.button === 0 && this.attached) {
        this.userAction(() => this.clickAt(mouse.col, mouse.row));
      }
      return;
    }
    if (this.promptState) { this.promptInput(s); return; }
    if (!this.attached && !['u', 'q', '\x03'].includes(s)) return;
    switch (s) {
      case 'u': this.openPrompt('URL: ', v => this.navigate(v)); break;
      case 'i': this.openPrompt('type: ', v => this.browser.type(v)); break;
      case 'b': this.userAction(() => this.browser.back()); break;
      case 'f': this.userAction(() => this.browser.forward()); break;
      case 'r': this.userAction(() => this.browser.reload()); break;
      case 'j': case ' ': this.userAction(() => this.browser.scroll('down', 300)); break;
      case 'k': this.userAction(() => this.browser.scroll('up', 300)); break;
      case 'q': case '\x03': this.cleanup(); process.exit(0);
    }
  }

  openPrompt(label, onSubmit) {
    this.promptState = { label, value: '', onSubmit };
    this.renderBottom();
  }

  promptInput(s) {
    const p = this.promptState;
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') {
        this.promptState = null;
        this.renderBottom();
        const v = p.value.trim();
        if (v) this.userAction(() => p.onSubmit(v));
        return;
      }
      if (ch === '\x1b') { this.promptState = null; this.renderBottom(); return; }
      if (ch === '\x7f' || ch === '\b') p.value = p.value.slice(0, -1);
      else if (ch >= ' ') p.value += ch;
    }
    this.renderBottom();
  }

  // User-initiated drive of the shared session: run the action, then refresh
  // immediately instead of waiting for the next poll tick.
  userAction(fn) {
    this.enqueue(async () => {
      try { await fn(); } catch { /* next tick's banner reports failures */ }
    }).then(() => this.enqueue(() => this.tick()));
  }

  async navigate(v) {
    const u = /^https?:\/\//.test(v) ? v : `https://${v}`;
    this.attached = true; // the user is explicitly starting/driving the session
    await this.browser.open(u);
  }

  async clickAt(col, row) {
    const { cols, imageRows, imageTopRow } = this.size();
    if (row < imageTopRow || row >= imageTopRow + imageRows) return;
    let dims;
    try { dims = pngDims(fs.readFileSync(this.shot)); } catch { return; }
    if (!dims) return;
    const pt = mapClickToPage(col, row, { cols, imageRows, imageTopRow, pngW: dims.w, pngH: dims.h });
    if (!pt) return;
    await this.browser.eval(
      `(() => { const el = document.elementFromPoint(${pt.x}, ${pt.y}); if (!el) return; if (el.focus) el.focus(); el.click(); })()`);
  }

  async redrawAll() {
    process.stdout.write(`${ESC}[2J`);
    if (this.mode === 'kitty') process.stdout.write(KITTY_DELETE);
    this.header();
    await this.renderImage();
    this.renderConsole();
  }

  cleanup() {
    if (this.mode === 'kitty') process.stdout.write(KITTY_DELETE);
    for (const f of [this.shot, this.shot + '.tmp']) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* fine */ }
    process.stdout.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[?1049l${ESC}[?25h`);
  }

  async run() {
    this.setupInput();
    const probe = await this.probeKitty();
    this.mode = pickRenderMode(this.env, this.configValue('render'), probe, this.chafa);
    process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
    if (this.mode === 'text') {
      this.consoleLines.push(this.chafa
        ? 'text mode (set render config to kitty/symbols for screenshots)'
        : 'chafa not found — text-only mode. Install: brew install chafa');
    }
    await this.redrawAll();
    process.stdout.write(`${ESC}[?1000h${ESC}[?1006h`);

    let resizeTimer = null;
    process.stdout.on('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.enqueue(() => this.redrawAll()), 150);
    });
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
      process.on(sig, () => { this.cleanup(); process.exit(0); });
    }

    while (true) {
      await this.enqueue(() => this.tick());
      await new Promise(r => setTimeout(r, this.intervalMs));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Construct inside the async wrapper so constructor failures (state-dir
  // permissions, etc.) hit the same catch and never flash-close the pane.
  (async () => { await new Renderer().run(); })().catch(err => {
    process.stdout.write(`${ESC}[?1049l${ESC}[?25h`);
    console.error('herdr-browser renderer crashed:', err.message);
    setTimeout(() => process.exit(1), 600_000);
  });
}
