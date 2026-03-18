import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import * as TOML from '@iarna/toml';

function getCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export function defaultConfigPath(): string {
  return path.join(getCodexHome(), 'config.toml');
}

function defaultWhichFn(cmd: string): string {
  return execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', cmd]).toString().trim();
}

function isBox0Notify(notify: unknown): boolean {
  if (!Array.isArray(notify)) return false;
  const last = notify[notify.length - 1];
  return typeof last === 'string' && last.includes('box0 import codex');
}

export function installCodexPlugin(opts?: { whichFn?: (cmd: string) => string }): { stdout: string; stderr: string; exitCode: number } {
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

  const configPath = defaultConfigPath();

  // Parse existing config if present
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    try {
      config = TOML.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        stdout: '',
        stderr: `Error: ${configPath} contains invalid TOML. Please manually fix or delete the file and retry.`,
        exitCode: 1,
      };
    }
  }

  // Check if notify is already set
  if (config.notify !== undefined) {
    if (isBox0Notify(config.notify)) {
      return {
        stdout: `ℹ Codex notify hook is already installed in ${configPath}, nothing to do.\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    // notify is occupied by another program
    return {
      stdout: '',
      stderr: `Error: ${configPath} already has a notify configuration that is not managed by box0. Please remove or update it manually.`,
      exitCode: 1,
    };
  }

  // Set notify
  config.notify = ['bash', '-lc', `${box0BinPath} import codex 2>/dev/null &`];

  // Ensure directory exists
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // Atomic write
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, TOML.stringify(config as TOML.JsonMap));
  fs.renameSync(tmpPath, configPath);

  const lines = [
    `✔ Codex notify hook installed in ${configPath}`,
    `  Codex will trigger \`box0 import codex\` after each agent turn.`,
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function uninstallCodexPlugin(): { stdout: string; stderr: string; exitCode: number } {
  const configPath = defaultConfigPath();

  if (!fs.existsSync(configPath)) {
    return { stdout: 'ℹ Codex notify hook is not installed, nothing to remove.\n', stderr: '', exitCode: 0 };
  }

  let config: Record<string, unknown>;
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    config = TOML.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      stdout: '',
      stderr: `Error: ${configPath} contains invalid TOML. Please manually fix the file and retry.`,
      exitCode: 1,
    };
  }

  if (!isBox0Notify(config.notify)) {
    return { stdout: 'ℹ Codex notify hook is not installed, nothing to remove.\n', stderr: '', exitCode: 0 };
  }

  delete config.notify;

  // Atomic write
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, TOML.stringify(config as TOML.JsonMap));
  fs.renameSync(tmpPath, configPath);

  const lines = [
    `✔ Codex notify hook removed from ${configPath}`,
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function getCodexPluginStatus(): { installed: boolean; configPath: string } {
  const configPath = defaultConfigPath();

  if (!fs.existsSync(configPath)) {
    return { installed: false, configPath };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = TOML.parse(raw) as Record<string, unknown>;
    return { installed: isBox0Notify(config.notify), configPath };
  } catch {
    return { installed: false, configPath };
  }
}
