import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-oc-plugin-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStubWhichFn(box0Path: string): (cmd: string) => string {
  return (cmd: string) => {
    if (cmd === 'box0') return box0Path;
    throw new Error(`command not found: ${cmd}`);
  };
}

describe('plugin-openclaw installer', () => {
  let openclawDir: string;
  let settingsPath: string;
  let fakeBin: string;
  let origOpenclawDir: string | undefined;
  let origSettingsPath: string | undefined;

  before(() => {
    origOpenclawDir = process.env.OPENCLAW_DIR;
    origSettingsPath = process.env.OPENCLAW_SETTINGS_PATH;
  });

  after(() => {
    if (origOpenclawDir !== undefined) {
      process.env.OPENCLAW_DIR = origOpenclawDir;
    } else {
      delete process.env.OPENCLAW_DIR;
    }
    if (origSettingsPath !== undefined) {
      process.env.OPENCLAW_SETTINGS_PATH = origSettingsPath;
    } else {
      delete process.env.OPENCLAW_SETTINGS_PATH;
    }
  });

  beforeEach(() => {
    openclawDir = makeTempDir();
    settingsPath = path.join(openclawDir, 'openclaw.json');
    fakeBin = '/usr/local/bin/box0';
    process.env.OPENCLAW_DIR = openclawDir;
    process.env.OPENCLAW_SETTINGS_PATH = settingsPath;
  });

  afterEach(() => {
    fs.rmSync(openclawDir, { recursive: true, force: true });
  });

  test('install creates extensions/box0/ directory when it does not exist', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    const whichFn = makeStubWhichFn(fakeBin);
    installOpenClawPlugin({ whichFn });
    const extensionDir = path.join(openclawDir, 'extensions', 'box0');
    assert.ok(fs.existsSync(extensionDir), 'extensions/box0/ dir should exist');
  });

  test('install writes openclaw.plugin.json and index.js', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    const whichFn = makeStubWhichFn(fakeBin);
    installOpenClawPlugin({ whichFn });
    const extensionDir = path.join(openclawDir, 'extensions', 'box0');
    assert.ok(fs.existsSync(path.join(extensionDir, 'openclaw.plugin.json')));
    assert.ok(fs.existsSync(path.join(extensionDir, 'index.js')));

    const meta = JSON.parse(fs.readFileSync(path.join(extensionDir, 'openclaw.plugin.json'), 'utf8'));
    assert.strictEqual(meta.id, 'box0');

    const indexContent = fs.readFileSync(path.join(extensionDir, 'index.js'), 'utf8');
    assert.ok(indexContent.includes('agent_end'));
    assert.ok(indexContent.includes('execFileAsync'));
  });

  test('install index.js uses absolute path (no tilde) for BOX0_BIN', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    const whichFn = makeStubWhichFn(fakeBin);
    installOpenClawPlugin({ whichFn });
    const extensionDir = path.join(openclawDir, 'extensions', 'box0');
    const indexContent = fs.readFileSync(path.join(extensionDir, 'index.js'), 'utf8');
    assert.ok(!indexContent.includes('~/'), 'index.js should not contain tilde paths');
    assert.ok(indexContent.includes(fakeBin), 'index.js should contain absolute BOX0_BIN path');
    assert.ok(fakeBin.startsWith('/'), 'fakeBin should be absolute');
  });

  test('install updates openclaw.json with entries and installs', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installOpenClawPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 0);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.plugins?.entries?.box0?.enabled, true);
    assert.strictEqual(settings.plugins?.installs?.box0?.source, 'local');
    assert.ok(settings.plugins?.installs?.box0?.installPath?.includes('extensions/box0'));
    assert.ok(settings.plugins?.installs?.box0?.installPath?.startsWith('/'));
  });

  test('install preserves existing openclaw.json content', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    fs.writeFileSync(settingsPath, JSON.stringify({ agents: { defaults: { model: {} } } }, null, 2));
    const whichFn = makeStubWhichFn(fakeBin);
    installOpenClawPlugin({ whichFn });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.agents, 'existing agents key should be preserved');
  });

  test('install is idempotent: does not duplicate entries, does update index.js', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    const whichFn1 = makeStubWhichFn('/usr/local/bin/box0-v1');
    const whichFn2 = makeStubWhichFn('/usr/local/bin/box0-v2');

    const result1 = installOpenClawPlugin({ whichFn: whichFn1 });
    assert.strictEqual(result1.exitCode, 0);
    const result2 = installOpenClawPlugin({ whichFn: whichFn2 });
    assert.strictEqual(result2.exitCode, 0);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // entries.box0 should be an object, not array
    assert.ok(typeof settings.plugins?.entries?.box0 === 'object' && !Array.isArray(settings.plugins.entries.box0));

    const extensionDir = path.join(openclawDir, 'extensions', 'box0');
    const indexContent = fs.readFileSync(path.join(extensionDir, 'index.js'), 'utf8');
    assert.ok(indexContent.includes('/usr/local/bin/box0-v2'), 'index.js should be updated to new path');
  });

  test('install returns error when openclaw.json contains invalid JSON', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    fs.writeFileSync(settingsPath, 'not-valid-json');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installOpenClawPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('invalid JSON'), `stderr: ${result.stderr}`);
  });

  test('install returns error when box0 binary is not in PATH', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    const alwaysThrow = (_cmd: string) => { throw new Error('command not found'); };
    const result = installOpenClawPlugin({ whichFn: alwaysThrow });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('box0'), `stderr: ${result.stderr}`);
  });

  test('uninstall removes entries and installs from openclaw.json', () => {
    const { installOpenClawPlugin, uninstallOpenClawPlugin } = require('../lib/plugin-openclaw');
    installOpenClawPlugin({ whichFn: makeStubWhichFn(fakeBin) });
    const result = uninstallOpenClawPlugin();
    assert.strictEqual(result.exitCode, 0);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(!settings.plugins?.entries?.box0, 'entries.box0 should be removed');
    assert.ok(!settings.plugins?.installs?.box0, 'installs.box0 should be removed');
  });

  test('uninstall handles missing openclaw.json gracefully (exitCode 0)', () => {
    const { uninstallOpenClawPlugin } = require('../lib/plugin-openclaw');
    // settingsPath does not exist
    const result = uninstallOpenClawPlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('uninstall handles not-installed state gracefully (exitCode 0)', () => {
    const { uninstallOpenClawPlugin } = require('../lib/plugin-openclaw');
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
    const result = uninstallOpenClawPlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('uninstall does not delete extensions/box0/ directory', () => {
    const { installOpenClawPlugin, uninstallOpenClawPlugin } = require('../lib/plugin-openclaw');
    installOpenClawPlugin({ whichFn: makeStubWhichFn(fakeBin) });
    const extensionDir = path.join(openclawDir, 'extensions', 'box0');
    uninstallOpenClawPlugin();
    assert.ok(fs.existsSync(extensionDir), 'extensions/box0/ should still exist after uninstall');
  });

  test('uninstall removes empty entries/installs keys completely', () => {
    const { installOpenClawPlugin, uninstallOpenClawPlugin } = require('../lib/plugin-openclaw');
    installOpenClawPlugin({ whichFn: makeStubWhichFn(fakeBin) });
    uninstallOpenClawPlugin();
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // entries and installs should be absent or empty
    const entries = settings.plugins?.entries ?? {};
    const installs = settings.plugins?.installs ?? {};
    assert.strictEqual(Object.keys(entries).length, 0);
    assert.strictEqual(Object.keys(installs).length, 0);
  });

  test('getOpenClawPluginStatus returns installed:true after install', () => {
    const { installOpenClawPlugin, getOpenClawPluginStatus } = require('../lib/plugin-openclaw');
    installOpenClawPlugin({ whichFn: makeStubWhichFn(fakeBin) });
    const status = getOpenClawPluginStatus();
    assert.strictEqual(status.installed, true);
    assert.ok(status.extensionDir.startsWith('/'));
  });

  test('getOpenClawPluginStatus returns installed:false in empty environment', () => {
    const { getOpenClawPluginStatus } = require('../lib/plugin-openclaw');
    const status = getOpenClawPluginStatus();
    assert.strictEqual(status.installed, false);
  });
});

describe('plugin command routing (openclaw)', () => {
  let openclawDir: string;
  let settingsPath: string;
  let box0Dir: string;
  let claudeSettingsPath: string;
  let origOpenclawDir: string | undefined;
  let origSettingsPath: string | undefined;
  let origBox0Dir: string | undefined;
  let origClaudePath: string | undefined;

  before(() => {
    origOpenclawDir = process.env.OPENCLAW_DIR;
    origSettingsPath = process.env.OPENCLAW_SETTINGS_PATH;
    origBox0Dir = process.env.BOX0_DIR;
    origClaudePath = process.env.CLAUDE_SETTINGS_PATH;
  });

  after(() => {
    if (origOpenclawDir !== undefined) process.env.OPENCLAW_DIR = origOpenclawDir; else delete process.env.OPENCLAW_DIR;
    if (origSettingsPath !== undefined) process.env.OPENCLAW_SETTINGS_PATH = origSettingsPath; else delete process.env.OPENCLAW_SETTINGS_PATH;
    if (origBox0Dir !== undefined) process.env.BOX0_DIR = origBox0Dir; else delete process.env.BOX0_DIR;
    if (origClaudePath !== undefined) process.env.CLAUDE_SETTINGS_PATH = origClaudePath; else delete process.env.CLAUDE_SETTINGS_PATH;
  });

  beforeEach(() => {
    openclawDir = makeTempDir();
    settingsPath = path.join(openclawDir, 'openclaw.json');
    box0Dir = makeTempDir();
    claudeSettingsPath = path.join(makeTempDir(), 'settings.json');
    process.env.OPENCLAW_DIR = openclawDir;
    process.env.OPENCLAW_SETTINGS_PATH = settingsPath;
    process.env.BOX0_DIR = box0Dir;
    process.env.CLAUDE_SETTINGS_PATH = claudeSettingsPath;
  });

  afterEach(() => {
    fs.rmSync(openclawDir, { recursive: true, force: true });
    fs.rmSync(box0Dir, { recursive: true, force: true });
    const claudeDir = path.dirname(claudeSettingsPath);
    if (fs.existsSync(claudeDir)) fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  test('runPluginInstall returns error for unknown agent (not claude-code, openclaw, or codex)', () => {
    const { runPluginInstall } = require('../commands/plugin');
    const result = runPluginInstall('cursor');
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stderr, 'Unknown agent: cursor. Supported: claude-code, openclaw, codex');
  });

  test('runPluginUninstall returns error for unknown agent', () => {
    const { runPluginUninstall } = require('../commands/plugin');
    const result = runPluginUninstall('openai');
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Supported: claude-code, openclaw, codex'));
  });

  test('runPluginStatus shows both agents when openclaw installed, claude-code not', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    installOpenClawPlugin({ whichFn: () => '/usr/local/bin/box0' });

    const { runPluginStatus } = require('../commands/plugin');
    const result = runPluginStatus();
    const plain = stripAnsi(result.stdout);
    assert.ok(plain.includes('Claude Code hook:'));
    assert.ok(plain.includes('✗ not installed'));
    assert.ok(plain.includes('OpenClaw plugin:'));
    assert.ok(plain.includes('✔ installed'));
  });

  test('runPluginStatus shows both agents when claude-code installed, openclaw not', () => {
    // Install claude-code plugin
    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const whichFn = (cmd: string) => {
      if (cmd === 'box0') return '/usr/local/bin/box0';
      if (cmd === 'jq') return '/usr/bin/jq';
      throw new Error(`not found: ${cmd}`);
    };
    installClaudeCodePlugin({ whichFn });

    const { runPluginStatus } = require('../commands/plugin');
    const result = runPluginStatus();
    const plain = stripAnsi(result.stdout);
    assert.ok(plain.includes('Claude Code hook:'));
    assert.ok(plain.includes('✔ installed'));
    assert.ok(plain.includes('OpenClaw plugin:'));
  });

  test('runPluginStatus shows both installed when both plugins are installed', () => {
    const { installOpenClawPlugin } = require('../lib/plugin-openclaw');
    installOpenClawPlugin({ whichFn: () => '/usr/local/bin/box0' });

    const { installClaudeCodePlugin } = require('../lib/plugin-claude-code');
    const ccWhich = (cmd: string) => {
      if (cmd === 'box0') return '/usr/local/bin/box0';
      if (cmd === 'jq') return '/usr/bin/jq';
      throw new Error(`not found: ${cmd}`);
    };
    installClaudeCodePlugin({ whichFn: ccWhich });

    const { runPluginStatus } = require('../commands/plugin');
    const result = runPluginStatus();
    const plain = stripAnsi(result.stdout);
    assert.ok(plain.includes('Claude Code hook:'));
    assert.ok(plain.includes('✔ installed'));
    assert.ok(plain.includes('OpenClaw plugin:'));
  });
});
