import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-plugin-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Stub whichFn that "finds" jq and a fake box0 binary
function makeStubWhichFn(box0BinPath: string): (cmd: string) => string {
  return (cmd: string) => {
    if (cmd === 'jq') return '/usr/bin/jq';
    if (cmd === 'box0') return box0BinPath;
    throw new Error(`command not found: ${cmd}`);
  };
}

describe('plugin-claude-code installer', () => {
  let box0Dir: string;
  let settingsDir: string;
  let settingsPath: string;
  let fakeBin: string;
  let origBox0Dir: string | undefined;
  let origSettingsPath: string | undefined;

  before(() => {
    origBox0Dir = process.env.BOX0_DIR;
    origSettingsPath = process.env.CLAUDE_SETTINGS_PATH;
  });

  after(() => {
    if (origBox0Dir !== undefined) {
      process.env.BOX0_DIR = origBox0Dir;
    } else {
      delete process.env.BOX0_DIR;
    }
    if (origSettingsPath !== undefined) {
      process.env.CLAUDE_SETTINGS_PATH = origSettingsPath;
    } else {
      delete process.env.CLAUDE_SETTINGS_PATH;
    }
  });

  beforeEach(() => {
    box0Dir = makeTempDir();
    settingsDir = makeTempDir();
    settingsPath = path.join(settingsDir, 'settings.json');
    fakeBin = '/usr/local/bin/box0';
    process.env.BOX0_DIR = box0Dir;
    process.env.CLAUDE_SETTINGS_PATH = settingsPath;
  });

  afterEach(() => {
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  test('install creates hooks directory when it does not exist', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    const hooksDir = path.join(box0Dir, 'hooks');
    assert.ok(fs.existsSync(hooksDir), 'hooks dir should exist');
  });

  test('install writes hook script with executable permission', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    const hookPath = path.join(box0Dir, 'hooks', 'box0-claude-sync.sh');
    assert.ok(fs.existsSync(hookPath), 'hook script should exist');
    const mode = fs.statSync(hookPath).mode;
    assert.ok(mode & 0o111, 'hook script should be executable');
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes('stop_hook_active'), 'script should check stop_hook_active');
    assert.ok(content.includes('import claude-code'), 'script should call box0 import');
  });

  test('install uses absolute paths (no tilde) in hook script', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    const hookPath = path.join(box0Dir, 'hooks', 'box0-claude-sync.sh');
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(!content.includes('~/'), 'hook script should not contain tilde paths');
    assert.ok(content.includes(fakeBin), 'hook script should contain absolute box0 path');
    assert.ok(fakeBin.startsWith('/'), 'box0 bin path should be absolute');
  });

  test('install updates settings.json with Stop hook using absolute path', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installClaudeCodePlugin({ whichFn });
    assert.strictEqual(result.exitCode, 0);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const stops = settings.hooks?.Stop;
    assert.ok(Array.isArray(stops), 'Stop hooks array should exist');
    const hookEntry = stops
      .flatMap((s: { hooks?: Array<{ command?: string; async?: boolean; timeout?: number }> }) => s.hooks ?? [])
      .find((h: { command?: string }) => typeof h.command === 'string' && h.command.includes('box0-claude-sync.sh'));
    assert.ok(hookEntry, 'box0-claude-sync.sh hook entry should exist in settings');
    assert.ok(typeof hookEntry.command === 'string' && hookEntry.command.startsWith('/'), 'command should be an absolute path');
    assert.strictEqual(hookEntry.async, true);
    assert.strictEqual(hookEntry.timeout, 30);
  });

  test('install preserves existing settings.json content', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.theme, 'dark', 'existing keys should be preserved');
  });

  test('install is idempotent (duplicate install does not add duplicate hook entry)', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    installClaudeCodePlugin({ whichFn });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const stops = settings.hooks?.Stop ?? [];
    const box0Entries = stops
      .flatMap((s: { hooks?: Array<{ command?: string }> }) => s.hooks ?? [])
      .filter((h: { command?: string }) => typeof h.command === 'string' && h.command.includes('box0-claude-sync.sh'));
    assert.strictEqual(box0Entries.length, 1, 'should have exactly one box0 hook entry');
  });

  test('install returns error when settings.json contains invalid JSON', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    fs.writeFileSync(settingsPath, 'not-valid-json');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installClaudeCodePlugin({ whichFn });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('invalid JSON'), 'stderr should mention invalid JSON');
  });

  test('install returns error when jq and python3 are both unavailable', () => {
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const alwaysThrow = (_cmd: string) => { throw new Error('not found'); };
    const result = installClaudeCodePlugin({ whichFn: alwaysThrow });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('jq') || result.stderr.includes('python3'), 'stderr should mention jq/python3');
  });

  test('uninstall removes hook from settings.json and cleans up empty keys', () => {
    const { installClaudeCodePlugin, uninstallClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    const result = uninstallClaudeCodePlugin();
    assert.strictEqual(result.exitCode, 0);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const stops = settings.hooks?.Stop ?? [];
    const box0Entries = stops
      .flatMap((s: { hooks?: Array<{ command?: string }> }) => s.hooks ?? [])
      .filter((h: { command?: string }) => typeof h.command === 'string' && h.command.includes('box0-claude-sync.sh'));
    assert.strictEqual(box0Entries.length, 0, 'box0 hook entry should be removed');
    // Since box0 was the only Stop hook, hooks.Stop should be removed
    assert.ok(!('hooks' in settings) || !('Stop' in (settings.hooks ?? {})), 'hooks.Stop key should be removed when empty');
  });

  test('uninstall is graceful when settings.json does not exist (exitCode 0)', () => {
    const { uninstallClaudeCodePlugin } = require('../lib/plugin-claude-code');
    // settingsPath does not exist
    const result = uninstallClaudeCodePlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('uninstall is graceful when hook is not installed (exitCode 0)', () => {
    const { uninstallClaudeCodePlugin } = require('../lib/plugin-claude-code');
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
    const result = uninstallClaudeCodePlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('getClaudeCodePluginStatus returns installed:true after install', () => {
    const { installClaudeCodePlugin, getClaudeCodePluginStatus } = require('../lib/plugin-claude-code');
    const whichFn = makeStubWhichFn(fakeBin);
    installClaudeCodePlugin({ whichFn });
    const status = getClaudeCodePluginStatus();
    assert.strictEqual(status.installed, true);
  });

  test('getClaudeCodePluginStatus returns installed:false in empty environment', () => {
    const { getClaudeCodePluginStatus } = require('../lib/plugin-claude-code');
    const status = getClaudeCodePluginStatus();
    assert.strictEqual(status.installed, false);
  });

  test('getClaudeCodePluginStatus returns absolute paths for hookPath and settingsPath', () => {
    const { getClaudeCodePluginStatus } = require('../lib/plugin-claude-code');
    const status = getClaudeCodePluginStatus();
    assert.ok(status.hookPath.startsWith('/'), 'hookPath should be absolute');
    assert.ok(status.settingsPath.startsWith('/'), 'settingsPath should be absolute');
  });
});

describe('plugin command routing', () => {
  test('runPluginInstall returns error for unknown agent', () => {
    const { runPluginInstall } = require('../commands/plugin');
    const result = runPluginInstall('openai');
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stderr, 'Unknown agent: openai. Supported: claude-code, openclaw, codex');
  });

  test('runPluginUninstall returns error for unknown agent', () => {
    const { runPluginUninstall } = require('../commands/plugin');
    const result = runPluginUninstall('openai');
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stderr, 'Unknown agent: openai. Supported: claude-code, openclaw, codex');
  });
});

// ─── Hook Script Integration Tests ───────────────────────────────────────────

function hasBash(): boolean {
  try { execSync('command -v bash'); return true; } catch { return false; }
}
function hasJq(): boolean {
  try { execSync('command -v jq'); return true; } catch { return false; }
}
function hasPython3(): boolean {
  try { execSync('command -v python3'); return true; } catch { return false; }
}

describe('hook script integration (bash + jq)', { skip: !hasBash() || !hasJq() }, () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeHookScript(box0BinPath: string): string {
    const { buildHookScript } = require('../lib/plugin-claude-code');
    const scriptPath = path.join(tmpDir, 'box0-claude-sync.sh');
    fs.writeFileSync(scriptPath, buildHookScript(tmpDir, box0BinPath), { mode: 0o755 });
    return scriptPath;
  }

  test('stop_hook_active=true: exits 0 and does not call box0', () => {
    // Write a mock box0 that records invocations
    const callLog = path.join(tmpDir, 'called.log');
    const mockBox0 = path.join(tmpDir, 'box0');
    fs.writeFileSync(mockBox0, `#!/bin/bash\necho "called" >> ${callLog}\n`, { mode: 0o755 });
    const scriptPath = writeHookScript(mockBox0);

    const stdin = JSON.stringify({ stop_hook_active: true, transcript_path: '/tmp/x.jsonl' });
    execSync(`bash ${scriptPath}`, { encoding: 'utf8', input: stdin, env: { ...process.env } });
    assert.ok(!fs.existsSync(callLog), 'mock box0 should not have been called');
  });

  test('transcript_path empty: exits 0 silently', () => {
    const mockBox0 = path.join(tmpDir, 'box0-noop');
    fs.writeFileSync(mockBox0, `#!/bin/bash\necho "called"\n`, { mode: 0o755 });
    const scriptPath = writeHookScript(mockBox0);

    const stdin = JSON.stringify({ stop_hook_active: false, transcript_path: '' });
    let exitCode = 0;
    try {
      execSync(`bash ${scriptPath}`, { encoding: 'utf8', input: stdin });
    } catch (e: unknown) {
      exitCode = (e as { status?: number }).status ?? 1;
    }
    assert.strictEqual(exitCode, 0);
  });

  test('box0 import fails: hook script still exits 0 (|| true)', () => {
    const mockBox0 = path.join(tmpDir, 'box0-fail');
    fs.writeFileSync(mockBox0, `#!/bin/bash\nexit 1\n`, { mode: 0o755 });
    const scriptPath = writeHookScript(mockBox0);

    const stdin = JSON.stringify({ stop_hook_active: false, transcript_path: '/nonexistent/path.jsonl' });
    let exitCode = 0;
    try {
      execSync(`bash ${scriptPath}`, { encoding: 'utf8', input: stdin });
    } catch (e: unknown) {
      exitCode = (e as { status?: number }).status ?? 1;
    }
    assert.strictEqual(exitCode, 0);
  });
});

describe('hook script integration (bash + python3 fallback, no jq)', { skip: !hasBash() || !hasPython3() }, () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeHookScript(box0BinPath: string): string {
    const { buildHookScript } = require('../lib/plugin-claude-code');
    const scriptPath = path.join(tmpDir, 'box0-claude-sync-py.sh');
    fs.writeFileSync(scriptPath, buildHookScript(tmpDir, box0BinPath), { mode: 0o755 });
    return scriptPath;
  }

  test('python3 fallback: stop_hook_active=true exits 0, does not call box0', () => {
    // Create a mock bin dir with python3 but no jq
    const mockBinDir = path.join(tmpDir, 'mockbin');
    fs.mkdirSync(mockBinDir, { recursive: true });

    // Symlink python3 from system
    const python3Path = execSync('command -v python3').toString().trim();
    fs.symlinkSync(python3Path, path.join(mockBinDir, 'python3'));

    // Mock box0 that records calls
    const callLog = path.join(tmpDir, 'py-called.log');
    const mockBox0 = path.join(mockBinDir, 'box0');
    fs.writeFileSync(mockBox0, `#!/bin/bash\necho "called" >> ${callLog}\n`, { mode: 0o755 });

    const scriptPath = writeHookScript(mockBox0);

    const stdin = JSON.stringify({ stop_hook_active: true, transcript_path: '/tmp/x.jsonl' });
    // Use restricted PATH: mockBinDir + /usr/bin + /bin but NO jq
    const restrictedPath = `${mockBinDir}:/usr/bin:/bin`;
    execSync(`bash ${scriptPath}`, {
      encoding: 'utf8',
      input: stdin,
      env: { ...process.env, PATH: restrictedPath },
    });
    assert.ok(!fs.existsSync(callLog), 'mock box0 should not have been called');
  });
});
