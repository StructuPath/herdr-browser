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
    PATH: `${stubDir}:/usr/bin:/bin`,
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
if [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  echo '{"id":"x","result":{"plugin_pane":{"pane":{"pane_id":"w9:p7"}}}}'
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

test('close closes pane then session, never --all', () => {
  fs.writeFileSync(path.join(stateDir, 'pane-id-w9'), 'w9:p7\n');
  const r = runScript('close.sh', [], freshEnv({ STUB_PANE_ALIVE: '0' }));
  assert.equal(r.status, 0, r.stderr);
  const l = log();
  assert.match(l, /herdr plugin pane close w9:p7/);
  assert.match(l, /agent-browser --session herdr-ws-w9 close/);
  assert.doesNotMatch(l, /--all/);
  assert.ok(l.indexOf('plugin pane close') < l.indexOf('--session herdr-ws-w9 close'),
    'pane must close before session');
  assert.equal(fs.existsSync(path.join(stateDir, 'pane-id-w9')), false);
});
