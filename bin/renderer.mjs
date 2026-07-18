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
      const name = fs.readFileSync(f, 'utf8').split('\n')[0].trim();
      if (name) return name;
    }
  }
  if (env.HERDR_WORKSPACE_ID) return `herdr-ws-${env.HERDR_WORKSPACE_ID}`;
  const sum = spawnSync('sh', ['-c', `printf '%s\\n' "${cwd}" | cksum`])
    .stdout.toString().split(' ')[0];
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

// --- terminal probe ---

function probeKittySupport(timeoutMs = 300) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve('');
    let buf = '';
    const done = ans => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(ans);
    };
    const onData = chunk => {
      buf += chunk.toString('latin1');
      // DA1 response terminates the probe: every terminal answers ESC [ ? ... c
      if (/\x1b\[\?[\d;]*c/.test(buf)) done(buf);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.write(`${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`);
    setTimeout(() => done(buf), timeoutMs);
  });
}

// --- agent-browser access ---

function makeBrowser(session, bin = 'agent-browser') {
  const run = async (...args) => {
    const { stdout } = await pExecFile(bin, ['--session', session, ...args, '--json']);
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
    sessionExists: async () => {
      try {
        const { stdout } = await pExecFile(bin, ['session', 'list', '--json']);
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
    this.resizePending = false;
  }

  size() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const consoleRows = this.mode === 'text' ? rows - 3 : Math.max(4, Math.floor(rows * 0.3));
    const imageRows = this.mode === 'text' ? 0 : rows - consoleRows - 4;
    return { cols, rows, imageRows, consoleRows };
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
    const line2 = this.banner
      ? truncate(` ! ${this.banner}`, cols)
      : truncate(` ${this.lastUrl}${this.lastTitle ? '  —  ' + this.lastTitle : ''}`, cols);
    process.stdout.write(`${ESC}[1;1H${ESC}[7m${line1}${ESC}[K${ESC}[0m`);
    process.stdout.write(`${ESC}[2;1H${line2}${ESC}[K`);
  }

  async renderImage(fromCache = false) {
    const { cols, imageRows } = this.size();
    if (this.mode === 'text' || imageRows < 3 || !fs.existsSync(this.shot)) return;
    const fmt = this.mode === 'kitty' ? 'kitty' : 'symbols';
    try {
      const { stdout } = await pExecFile(
        'chafa', ['-f', fmt, '-s', `${cols}x${imageRows}`, '--animate', 'off', this.shot],
        { maxBuffer: 32 * 1024 * 1024 },
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
      const prefix = e.type === 'error' ? '✖ ' : e.type === 'warn' ? '⚠ ' : '  ';
      this.consoleLines.push(prefix + (e.text ?? ''));
    }
    if (this.consoleLines.length > 500) {
      this.consoleLines = this.consoleLines.slice(-500);
    }
  }

  async tick() {
    let failed = false;
    try {
      const [url, title] = [await this.browser.url(), await this.browser.title()];
      if (url !== this.lastUrl || title !== this.lastTitle) {
        this.lastUrl = url;
        this.lastTitle = title;
      }
      const entries = await this.browser.console();
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
      this.banner = (await this.browser.sessionExists())
        ? 'agent-browser not responding — retrying'
        : `session "${this.session}" is not running — invoke "Browser: Open" to start it`;
    }
    this.header();
  }

  async redrawAll() {
    process.stdout.write(`${ESC}[2J`);
    if (this.mode === 'kitty') process.stdout.write(KITTY_DELETE);
    this.header();
    await this.renderImage(true);
    this.renderConsole();
  }

  cleanup() {
    if (this.mode === 'kitty') process.stdout.write(KITTY_DELETE);
    for (const f of [this.shot, this.shot + '.tmp']) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    process.stdout.write(`${ESC}[?1049l${ESC}[?25h`);
  }

  async run() {
    const probe = await probeKittySupport();
    this.mode = pickRenderMode(this.env, this.configValue('render'), probe, this.chafa);
    process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
    if (this.mode === 'text') {
      this.consoleLines.push(this.chafa
        ? 'text mode (set render config to kitty/symbols for screenshots)'
        : 'chafa not found — text-only mode. Install: brew install chafa');
    }
    await this.redrawAll();

    let resizeTimer = null;
    process.stdout.on('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.redrawAll(), 150);
    });
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
      process.on(sig, () => { this.cleanup(); process.exit(0); });
    }

    while (true) {
      await this.tick();
      await new Promise(r => setTimeout(r, this.intervalMs));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  new Renderer().run().catch(err => {
    process.stdout.write(`${ESC}[?1049l${ESC}[?25h`);
    console.error('herdr-browser renderer crashed:', err.message);
    setTimeout(() => process.exit(1), 600_000);
  });
}
