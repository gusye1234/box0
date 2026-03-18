import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

function getBox0Dir(): string {
  return process.env.BOX0_DIR ?? path.join(os.homedir(), '.box0');
}

function getSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? path.join(os.homedir(), '.claude', 'settings.json');
}

function getHookScriptPath(box0Dir: string): string {
  return path.join(box0Dir, 'hooks', 'box0-claude-sync.sh');
}

export function buildHookScript(box0Dir: string, box0BinPath: string): string {
  const template = `#!/bin/bash
# box0 Claude Code sync hook — auto-generated, do not edit manually

LOG="__BOX0_DIR__/logs/hook.log"
mkdir -p "$(dirname "$LOG")"

INPUT=$(cat) || exit 0

# Use jq if available, otherwise fall back to python3
if command -v jq >/dev/null 2>&1; then
  STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null) || STOP_HOOK_ACTIVE="false"
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT_PATH=""
elif command -v python3 >/dev/null 2>&1; then
  STOP_HOOK_ACTIVE=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d.get('stop_hook_active', False)).lower())" 2>/dev/null) || STOP_HOOK_ACTIVE="false"
  TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path', ''))" 2>/dev/null) || TRANSCRIPT_PATH=""
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: neither jq nor python3 available" >> "$LOG"
  exit 0
fi

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

if [ -z "$TRANSCRIPT_PATH" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: empty transcript_path" >> "$LOG"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] importing $TRANSCRIPT_PATH" >> "$LOG"
__BOX0_BIN__ import claude-code --file "$TRANSCRIPT_PATH" </dev/null >> "$LOG" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] exit=$?" >> "$LOG"

exit 0
`;
  return template
    .replace(/__BOX0_BIN__/g, box0BinPath)
    .replace(/__BOX0_DIR__/g, box0Dir);
}

interface HookEntry {
  type?: string;
  command?: string;
  async?: boolean;
  timeout?: number;
}

interface StopEntry {
  matcher?: string;
  hooks?: HookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    Stop?: StopEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function isBox0HookInstalled(settings: ClaudeSettings): boolean {
  const stops = settings.hooks?.Stop;
  if (!Array.isArray(stops)) return false;
  for (const entry of stops) {
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (typeof hook.command === 'string' && hook.command.includes('box0-claude-sync.sh')) {
        return true;
      }
    }
  }
  return false;
}

function defaultWhichFn(cmd: string): string {
  // Pass cmd as a positional argument ($1) to avoid shell injection
  return execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', cmd]).toString().trim();
}

export function installClaudeCodePlugin(opts?: { whichFn?: (cmd: string) => string }): { stdout: string; stderr: string; exitCode: number } {
  const whichFn = opts?.whichFn ?? defaultWhichFn;

  // Check jq or python3
  let hasJq = false;
  let hasPython3 = false;
  try { whichFn('jq'); hasJq = true; } catch { /* not available */ }
  try { whichFn('python3'); hasPython3 = true; } catch { /* not available */ }
  if (!hasJq && !hasPython3) {
    return {
      stdout: '',
      stderr: 'Error: neither jq nor python3 is available. Please install jq or python3 and retry.',
      exitCode: 1,
    };
  }

  // Check box0 binary
  let box0BinPath: string;
  try {
    box0BinPath = whichFn('box0');
  } catch {
    return {
      stdout: '',
      stderr: 'Error: box0 binary not found in PATH. Please ensure box0 is installed (npm run build && npm link) and retry.',
      exitCode: 1,
    };
  }

  const box0Dir = getBox0Dir();
  const hooksDir = path.join(box0Dir, 'hooks');
  const logsDir = path.join(box0Dir, 'logs');
  const hookScriptPath = getHookScriptPath(box0Dir);
  const settingsPath = getSettingsPath();

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  // Write hook script
  const scriptContent = buildHookScript(box0Dir, box0BinPath);
  fs.writeFileSync(hookScriptPath, scriptContent, { mode: 0o755 });

  // Read settings.json
  let settings: ClaudeSettings = {};
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

  // Inject Stop hook (idempotent)
  if (!isBox0HookInstalled(settings)) {
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: hookScriptPath,
          async: true,
          timeout: 30,
        },
      ],
    });
  }

  // Atomic write
  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, settingsPath);

  const lines = [
    `✔ Hook script written to ${hookScriptPath}`,
    `✔ ${settingsPath} updated with Stop hook`,
    `✔ Claude Code plugin installed. Sessions will now auto-sync after each conversation.`,
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function uninstallClaudeCodePlugin(): { stdout: string; stderr: string; exitCode: number } {
  const settingsPath = getSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return { stdout: 'ℹ Claude Code hook is not installed, nothing to remove.\n', stderr: '', exitCode: 0 };
  }

  let settings: ClaudeSettings;
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

  if (!isBox0HookInstalled(settings)) {
    return { stdout: 'ℹ Claude Code hook is not installed, nothing to remove.\n', stderr: '', exitCode: 0 };
  }

  // Remove box0 hook entries
  if (Array.isArray(settings.hooks?.Stop)) {
    settings.hooks!.Stop = settings.hooks!.Stop!
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter(
          (h) => !(typeof h.command === 'string' && h.command.includes('box0-claude-sync.sh'))
        ),
      }))
      .filter((entry) => (entry.hooks?.length ?? 0) > 0);

    if (settings.hooks!.Stop!.length === 0) {
      delete settings.hooks!.Stop;
    }

    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, settingsPath);

  const lines = [
    `✔ Stop hook removed from ${settingsPath}`,
    `✔ Claude Code plugin uninstalled.`,
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function getClaudeCodePluginStatus(): { installed: boolean; hookPath: string; settingsPath: string } {
  const settingsPath = getSettingsPath();
  const box0Dir = getBox0Dir();
  const hookPath = getHookScriptPath(box0Dir);

  if (!fs.existsSync(settingsPath)) {
    return { installed: false, hookPath, settingsPath };
  }

  let settings: ClaudeSettings;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch {
    return { installed: false, hookPath, settingsPath };
  }

  return { installed: isBox0HookInstalled(settings), hookPath, settingsPath };
}
