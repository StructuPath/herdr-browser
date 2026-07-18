import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let stubDir, stateDir, logFile;

function writeStub(name, body) {
  const p = path.join(stubDir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}`);
  fs.chmodSync(p, 0o755);
}

function freshEnv(overrides = {}) {
  fs.writeFileSync(logFile, '');
  return {
    PATH: `${stubDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: os.homedir(),
    STUB_LOG: logFile,
    HERDR_BIN_PATH: path.join(stubDir, 'herdr'),
    HERDR_PLUGIN_ROOT: repoRoot,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_WORKSPACE_ID: 'w9',
    ...overrides,
  };
}

function runScript(script, args = [], env = freshEnv()) {
  return spawnSync('bash', [path.join(repoRoot, 'scripts', script), ...args],
    { env, encoding: 'utf8' });
}

const log = () => fs.readFileSync(logFile, 'utf8');

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-stub-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-state-'));
  logFile = path.join(stubDir, 'calls.log');
  writeStub('agent-browser', `echo "agent-browser $@" >> "$STUB_LOG"
echo '{"success":true,"data":{}}'`);
  writeStub('herdr', `echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "pane" ] && [ "$2" = "read" ]; then exit "\${STUB_PANE_ALIVE:-1}"; fi
if [ "$1" = "api" ] && [ "$2" = "snapshot" ]; then
  echo '{"result":{"workspaces":[{"tabs":[{"panes":[{"pane_id":"w9:p9","label":"Browser"},{"pane_id":"w9:p4","label":"claude"},{"pane_id":"w8:p2","label":"Browser"}]}]}]}}'
fi
if [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  if [ -n "\${STUB_PRETTY:-}" ]; then
    printf '{\\n  "result": {\\n    "plugin_pane": {"pane": {"pane_id": "w9:p7"}}\\n  }\\n}\\n'
  else
    echo '{"id":"x","result":{"plugin_pane":{"pane":{"pane_id":"w9:p7"}}}}'
  fi
fi
exit 0`);
});

test('open with URL navigates workspace session and opens pane', () => {
  const r = runScript('open.sh', ['http://localhost:3000']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(log(), /agent-browser --session herdr-ws-w9 open http:\/\/localhost:3000/);
  assert.match(log(), /herdr plugin pane open --plugin structupath\.browser/);
  assert.equal(
    fs.readFileSync(path.join(stateDir, 'pane-id-w9'), 'utf8').trim(), 'w9:p7');
});

test('open with live pane focuses instead of opening a second pane', () => {
  fs.writeFileSync(path.join(stateDir, 'pane-id-w9'), 'w9:p7\n');
  const r = runScript('open.sh', ['http://localhost:4000'], freshEnv({ STUB_PANE_ALIVE: '0' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(log(), /herdr plugin pane focus w9:p7/);
  assert.doesNotMatch(log(), /plugin pane open/);
});

test('URL-less open is view-only: ensures pane, never navigates', () => {
  fs.rmSync(path.join(stateDir, 'pane-id-w9'), { force: true });
  const r = runScript('open.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(log(), /agent-browser --session \S+ open/);
  assert.match(log(), /herdr plugin pane open/);
});

test('flag-like URL is refused before any tool runs', () => {
  const r = runScript('open.sh', ['-rf']);
  assert.equal(r.status, 2);
  assert.doesNotMatch(log(), /agent-browser/);
  assert.doesNotMatch(log(), /pane open/);
});

test('non-http scheme is refused', () => {
  const r = runScript('open.sh', ['file:///etc/passwd']);
  assert.equal(r.status, 2);
  assert.doesNotMatch(log(), /agent-browser/);
});

test('missing agent-browser fails fast with install hint, no pane', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bare-'));
  for (const t of ['herdr']) {
    fs.copyFileSync(path.join(stubDir, t), path.join(bare, t));
    fs.chmodSync(path.join(bare, t), 0o755);
  }
  const r = runScript('open.sh', ['http://localhost:3000'],
    freshEnv({ PATH: `${bare}:/usr/bin:/bin` }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm install -g agent-browser/);
  assert.doesNotMatch(log(), /pane open/);
});

test('unparseable pane-open output warns without failing or writing pidfile', () => {
  fs.rmSync(path.join(stateDir, 'pane-id-w9'), { force: true });
  const r = runScript('open.sh', ['http://localhost:3000'], freshEnv({ STUB_PRETTY: '1' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not parse pane id/);
  assert.equal(fs.existsSync(path.join(stateDir, 'pane-id-w9')), false);
});

test('close removes only this workspace screenshot cache', () => {
  fs.writeFileSync(path.join(stateDir, 'shot-w9.png'), 'x');
  fs.writeFileSync(path.join(stateDir, 'shot-w9.png.tmp'), 'x');
  fs.writeFileSync(path.join(stateDir, 'shot-other.png'), 'x');
  const r = runScript('close.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(stateDir, 'shot-w9.png')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'shot-w9.png.tmp')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'shot-other.png')), true);
});

test('browse with URL opens browse pane passing URL via env', () => {
  const r = runScript('browse.sh', ['http://localhost:3000']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(log(), /--entrypoint browse/);
  assert.match(log(), /HERDR_BROWSE_URL=http:\/\/localhost:3000/);
});

test('browse refuses flag-like and non-http URLs', () => {
  assert.equal(runScript('browse.sh', ['-evil']).status, 2);
  assert.equal(runScript('browse.sh', ['file:///etc/passwd']).status, 2);
});

test('browse with no URL opens pane without URL env (pane will prompt)', () => {
  const r = runScript('browse.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(log(), /--entrypoint browse/);
  assert.doesNotMatch(log(), /HERDR_BROWSE_URL/);
});

test('close sweeps untracked Browser panes in its workspace only', () => {
  fs.rmSync(path.join(stateDir, 'pane-id-w9'), { force: true });
  const r = runScript('close.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(log(), /herdr pane close w9:p9/);
  assert.doesNotMatch(log(), /pane close w8:p2/, 'other workspaces untouched');
  assert.doesNotMatch(log(), /pane close w9:p4/, 'non-plugin panes untouched');
});

test('close closes pane then session, never --all', () => {
  fs.writeFileSync(path.join(stateDir, 'pane-id-w9'), 'w9:p7\n');
  const r = runScript('close.sh', [], freshEnv({ STUB_PANE_ALIVE: '0' }));
  assert.equal(r.status, 0, r.stderr);
  const l = log();
  assert.match(l, /herdr pane close w9:p7/);
  assert.match(l, /agent-browser --session herdr-ws-w9 close/);
  assert.doesNotMatch(l, /--all/);
  assert.ok(l.indexOf('pane close') < l.indexOf('--session herdr-ws-w9 close'),
    'pane must close before session');
  assert.equal(fs.existsSync(path.join(stateDir, 'pane-id-w9')), false);
});
