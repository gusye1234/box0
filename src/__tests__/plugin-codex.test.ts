import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-codex-plugin-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStubWhichFn(box0Path: string): (cmd: string) => string {
  return (cmd: string) => {
    if (cmd === 'box0') return box0Path;
    throw new Error(`command not found: ${cmd}`);
  };
}

describe('plugin-codex installer', () => {
  let codexHome: string;
  let configPath: string;
  let fakeBin: string;
  let origCodexHome: string | undefined;

  before(() => {
    origCodexHome = process.env.CODEX_HOME;
  });

  after(() => {
    if (origCodexHome !== undefined) {
      process.env.CODEX_HOME = origCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  beforeEach(() => {
    codexHome = makeTempDir();
    configPath = path.join(codexHome, 'config.toml');
    fakeBin = '/usr/local/bin/box0';
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('install creates config.toml when it does not exist', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installCodexPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(fs.existsSync(configPath), 'config.toml should exist');
  });

  test('install adds notify field, preserves other config', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    fs.writeFileSync(configPath, 'model = "o3"\n');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installCodexPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 0);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('box0 import codex'), 'should contain box0 import codex');
    // model key should be preserved
    const TOML = require('@iarna/toml');
    const parsed = TOML.parse(content);
    assert.strictEqual(parsed.model, 'o3', 'existing model key should be preserved');
  });

  test('install writes notify as array with last element containing box0 import codex', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    const whichFn = makeStubWhichFn(fakeBin);
    installCodexPlugin({ whichFn });

    const TOML = require('@iarna/toml');
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(Array.isArray(parsed.notify), 'notify should be an array');
    const last = parsed.notify[parsed.notify.length - 1];
    assert.ok(typeof last === 'string' && last.includes('box0 import codex'));
  });

  test('install returns error when config.toml contains invalid TOML', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    fs.writeFileSync(configPath, '= invalid toml [[[');
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installCodexPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('invalid TOML'), `stderr: ${result.stderr}`);
  });

  test('install is idempotent: returns success when already installed', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    const whichFn = makeStubWhichFn(fakeBin);
    const result1 = installCodexPlugin({ whichFn });
    assert.strictEqual(result1.exitCode, 0);
    const result2 = installCodexPlugin({ whichFn });
    assert.strictEqual(result2.exitCode, 0);
    assert.ok(result2.stdout.includes('already installed'));
  });

  test('install returns error when notify is occupied by another program', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    const TOML = require('@iarna/toml');
    fs.writeFileSync(configPath, TOML.stringify({ notify: ['bash', '-c', 'some-other-tool'] }));
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installCodexPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('already has a notify configuration'));
  });

  test('install returns error when box0 binary is not in PATH', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    const alwaysThrow = (_cmd: string) => { throw new Error('command not found'); };
    const result = installCodexPlugin({ whichFn: alwaysThrow });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('box0'), `stderr: ${result.stderr}`);
  });

  test('install creates ~/.codex/ directory when it does not exist', () => {
    const { installCodexPlugin } = require('../lib/plugin-codex');
    // Use a subdirectory that doesn't exist yet
    const nestedHome = path.join(codexHome, 'nested', 'codex');
    process.env.CODEX_HOME = nestedHome;
    const whichFn = makeStubWhichFn(fakeBin);
    const result = installCodexPlugin({ whichFn });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(fs.existsSync(path.join(nestedHome, 'config.toml')));
    // Restore
    process.env.CODEX_HOME = codexHome;
  });

  test('uninstall removes notify field when it is box0 config', () => {
    const { installCodexPlugin, uninstallCodexPlugin } = require('../lib/plugin-codex');
    const whichFn = makeStubWhichFn(fakeBin);
    installCodexPlugin({ whichFn });
    const result = uninstallCodexPlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('removed'));

    const TOML = require('@iarna/toml');
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.notify, undefined, 'notify should be removed');
  });

  test('uninstall preserves other config keys after removing notify', () => {
    const { installCodexPlugin, uninstallCodexPlugin } = require('../lib/plugin-codex');
    const TOML = require('@iarna/toml');
    fs.writeFileSync(configPath, TOML.stringify({ model: 'o3' }));
    const whichFn = makeStubWhichFn(fakeBin);
    installCodexPlugin({ whichFn });
    uninstallCodexPlugin();
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.model, 'o3', 'model key should be preserved');
    assert.strictEqual(parsed.notify, undefined, 'notify should be removed');
  });

  test('uninstall does not modify when notify belongs to another program', () => {
    const { uninstallCodexPlugin } = require('../lib/plugin-codex');
    const TOML = require('@iarna/toml');
    fs.writeFileSync(configPath, TOML.stringify({ notify: ['bash', '-c', 'other-tool'] }));
    const result = uninstallCodexPlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('uninstall returns error when config.toml contains invalid TOML', () => {
    const { uninstallCodexPlugin } = require('../lib/plugin-codex');
    fs.writeFileSync(configPath, '= invalid toml [[[');
    const result = uninstallCodexPlugin();
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('invalid TOML'));
  });

  test('uninstall handles missing config.toml gracefully (exitCode 0)', () => {
    const { uninstallCodexPlugin } = require('../lib/plugin-codex');
    const result = uninstallCodexPlugin();
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('getCodexPluginStatus returns installed:true after install', () => {
    const { installCodexPlugin, getCodexPluginStatus } = require('../lib/plugin-codex');
    installCodexPlugin({ whichFn: makeStubWhichFn(fakeBin) });
    const status = getCodexPluginStatus();
    assert.strictEqual(status.installed, true);
    assert.ok(status.configPath.includes('config.toml'));
  });

  test('getCodexPluginStatus returns installed:false when not installed', () => {
    const { getCodexPluginStatus } = require('../lib/plugin-codex');
    const status = getCodexPluginStatus();
    assert.strictEqual(status.installed, false);
    assert.ok(status.configPath.includes('config.toml'));
  });

  test('getCodexPluginStatus returns installed:false when config.toml is invalid TOML', () => {
    const { getCodexPluginStatus } = require('../lib/plugin-codex');
    fs.writeFileSync(configPath, '= invalid toml [[[');
    const status = getCodexPluginStatus();
    assert.strictEqual(status.installed, false);
  });

  test('test isolation: uses CODEX_HOME env for temp directory', () => {
    const { defaultConfigPath } = require('../lib/plugin-codex');
    const cp = defaultConfigPath();
    assert.ok(cp.startsWith(codexHome), `configPath should start with CODEX_HOME: ${cp}`);
  });
});

describe('plugin command routing (codex)', () => {
  let codexHome: string;
  let box0Dir: string;
  let claudeSettingsPath: string;
  let openclawDir: string;
  let openclawSettingsPath: string;
  let origCodexHome: string | undefined;
  let origBox0Dir: string | undefined;
  let origClaudePath: string | undefined;
  let origOpenclawDir: string | undefined;
  let origOpenclawSettings: string | undefined;

  before(() => {
    origCodexHome = process.env.CODEX_HOME;
    origBox0Dir = process.env.BOX0_DIR;
    origClaudePath = process.env.CLAUDE_SETTINGS_PATH;
    origOpenclawDir = process.env.OPENCLAW_DIR;
    origOpenclawSettings = process.env.OPENCLAW_SETTINGS_PATH;
  });

  after(() => {
    if (origCodexHome !== undefined) process.env.CODEX_HOME = origCodexHome; else delete process.env.CODEX_HOME;
    if (origBox0Dir !== undefined) process.env.BOX0_DIR = origBox0Dir; else delete process.env.BOX0_DIR;
    if (origClaudePath !== undefined) process.env.CLAUDE_SETTINGS_PATH = origClaudePath; else delete process.env.CLAUDE_SETTINGS_PATH;
    if (origOpenclawDir !== undefined) process.env.OPENCLAW_DIR = origOpenclawDir; else delete process.env.OPENCLAW_DIR;
    if (origOpenclawSettings !== undefined) process.env.OPENCLAW_SETTINGS_PATH = origOpenclawSettings; else delete process.env.OPENCLAW_SETTINGS_PATH;
  });

  beforeEach(() => {
    codexHome = makeTempDir();
    box0Dir = makeTempDir();
    claudeSettingsPath = path.join(makeTempDir(), 'settings.json');
    openclawDir = makeTempDir();
    openclawSettingsPath = path.join(openclawDir, 'openclaw.json');
    process.env.CODEX_HOME = codexHome;
    process.env.BOX0_DIR = box0Dir;
    process.env.CLAUDE_SETTINGS_PATH = claudeSettingsPath;
    process.env.OPENCLAW_DIR = openclawDir;
    process.env.OPENCLAW_SETTINGS_PATH = openclawSettingsPath;
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(openclawDir, { recursive: true, force: true });
    const claudeDir = path.dirname(claudeSettingsPath);
    if (fs.existsSync(claudeDir)) fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  test('runPluginInstall("codex") calls installCodexPlugin', () => {
    const { runPluginInstall } = require('../commands/plugin');
    // Without a real box0 binary, it should return exitCode 1 (not unknown agent error)
    const result = runPluginInstall('codex');
    // It should NOT be "Unknown agent" — it should be the box0-not-found error
    assert.ok(!result.stderr.includes('Unknown agent'), 'codex should be a recognized agent');
  });

  test('runPluginUninstall("codex") calls uninstallCodexPlugin', () => {
    const { runPluginUninstall } = require('../commands/plugin');
    const result = runPluginUninstall('codex');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('not installed'));
  });

  test('runPluginStatus() includes Codex status line', () => {
    const { runPluginStatus } = require('../commands/plugin');
    const result = runPluginStatus();
    assert.ok(result.stdout.includes('Codex notify:'), `stdout should include Codex line: ${result.stdout}`);
  });
});
