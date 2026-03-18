import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

function getOpenClawDir(): string {
  return process.env.OPENCLAW_DIR ?? path.join(os.homedir(), '.openclaw');
}

function getSettingsPath(): string {
  return process.env.OPENCLAW_SETTINGS_PATH ?? path.join(getOpenClawDir(), 'openclaw.json');
}

function defaultWhichFn(cmd: string): string {
  return execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', cmd]).toString().trim();
}

export function buildOpenClawPluginScript(box0BinPath: string): string {
  const template = `'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const BOX0_BIN = '__BOX0_BIN__';

module.exports = {
  register(api) {
    api.on('agent_end', async (event, ctx) => {
      if (!event.success) return;
      const messages = event.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      const sessionKey = ctx.sessionKey ?? 'default';
      const payload = JSON.stringify({
        sessionKey,
        messages,
        workspaceDir: ctx.workspaceDir,
      });
      try {
        await execFileAsync(BOX0_BIN, ['import', 'openclaw', '--stdin'], {
          input: payload,
          timeout: 30000,
        });
      } catch (err) {
        api.logger.warn('[box0] import failed: ' + (err?.message ?? String(err)));
      }
    });
  },
};
`;
  return template.replace(/__BOX0_BIN__/g, box0BinPath);
}

interface OpenClawSettings {
  plugins?: {
    entries?: Record<string, { enabled: boolean }>;
    installs?: Record<string, { source: string; installPath: string }>;
  };
  [key: string]: unknown;
}

export function installOpenClawPlugin(opts?: { whichFn?: (cmd: string) => string }): { stdout: string; stderr: string; exitCode: number } {
  const whichFn = opts?.whichFn ?? defaultWhichFn;

  let box0BinPath: string;
  try {
    box0BinPath = whichFn('box0');
  } catch {
    return {
      stdout: '',
      stderr: 'Error: box0 binary not found in PATH. Please install box0 globally (npm install -g box0) and retry.',
      exitCode: 1,
    };
  }

  const openclawDir = getOpenClawDir();
  const settingsPath = getSettingsPath();
  const extensionDir = path.join(openclawDir, 'extensions', 'box0');

  fs.mkdirSync(extensionDir, { recursive: true });

  // Write openclaw.plugin.json
  const pluginMeta = { id: 'box0', name: 'box0 Session Sync', description: 'Auto-sync OpenClaw sessions to box0 SQLite DB after each agent turn' };
  fs.writeFileSync(path.join(extensionDir, 'openclaw.plugin.json'), JSON.stringify(pluginMeta, null, 2));

  // Write index.js (always overwrite to keep BOX0_BIN up to date)
  fs.writeFileSync(path.join(extensionDir, 'index.js'), buildOpenClawPluginScript(box0BinPath));

  // Read/parse openclaw.json
  let settings: OpenClawSettings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch {
      return {
        stdout: '',
        stderr: `Error: ${settingsPath} contains invalid JSON. Please manually fix or delete the file and retry.`,
        exitCode: 1,
      };
    }
  }

  // Idempotent check: only inject if not already registered
  const alreadyRegistered = settings.plugins?.entries?.['box0'] !== undefined;
  if (!alreadyRegistered) {
    if (!settings.plugins) settings.plugins = {};
    if (!settings.plugins.entries) settings.plugins.entries = {};
    if (!settings.plugins.installs) settings.plugins.installs = {};
    settings.plugins.entries['box0'] = { enabled: true };
    settings.plugins.installs['box0'] = { source: 'local', installPath: extensionDir };

    // Atomic write
    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, settingsPath);
  }

  const lines = [
    `✔ Plugin files written to ${extensionDir}/`,
    `✔ ${settingsPath} updated with box0 plugin entry`,
    `✔ OpenClaw plugin installed. Sessions will now auto-sync after each agent turn.`,
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function uninstallOpenClawPlugin(): { stdout: string; stderr: string; exitCode: number } {
  const settingsPath = getSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return { stdout: 'ℹ OpenClaw plugin is not installed, nothing to remove.\n', stderr: '', exitCode: 0 };
  }

  let settings: OpenClawSettings;
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    settings = JSON.parse(raw);
  } catch {
    return {
      stdout: '',
      stderr: `Error: ${settingsPath} contains invalid JSON. Please manually fix the file and retry.`,
      exitCode: 1,
    };
  }

  if (!settings.plugins?.entries?.['box0']) {
    return { stdout: 'ℹ OpenClaw plugin is not installed, nothing to remove.\n', stderr: '', exitCode: 0 };
  }

  delete settings.plugins!.entries!['box0'];
  if (settings.plugins!.installs) {
    delete settings.plugins!.installs['box0'];
  }

  // Clean up empty entries/installs keys
  if (settings.plugins!.entries && Object.keys(settings.plugins!.entries).length === 0) {
    delete settings.plugins!.entries;
  }
  if (settings.plugins!.installs && Object.keys(settings.plugins!.installs).length === 0) {
    delete settings.plugins!.installs;
  }
  if (settings.plugins && Object.keys(settings.plugins).length === 0) {
    delete settings.plugins;
  }

  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, settingsPath);

  const lines = [
    `✔ box0 removed from ${settingsPath}`,
    `✔ OpenClaw plugin uninstalled.`,
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function getOpenClawPluginStatus(): { installed: boolean; extensionDir: string; settingsPath: string } {
  const openclawDir = getOpenClawDir();
  const settingsPath = getSettingsPath();
  const extensionDir = path.join(openclawDir, 'extensions', 'box0');

  if (!fs.existsSync(settingsPath)) {
    return { installed: false, extensionDir, settingsPath };
  }

  let settings: OpenClawSettings;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch {
    return { installed: false, extensionDir, settingsPath };
  }

  const installed = settings.plugins?.entries?.['box0']?.enabled === true;
  return { installed, extensionDir, settingsPath };
}
