import { Command } from 'commander';
import { installClaudeCodePlugin, uninstallClaudeCodePlugin, getClaudeCodePluginStatus } from '../lib/plugin-claude-code';
import { installOpenClawPlugin, uninstallOpenClawPlugin, getOpenClawPluginStatus } from '../lib/plugin-openclaw';
import { installCodexPlugin, uninstallCodexPlugin, getCodexPluginStatus } from '../lib/plugin-codex';

export function runPluginInstall(agent: string): { stdout: string; stderr: string; exitCode: number } {
  if (agent === 'claude-code') {
    return installClaudeCodePlugin();
  } else if (agent === 'openclaw') {
    return installOpenClawPlugin();
  } else if (agent === 'codex') {
    return installCodexPlugin();
  }
  return { stdout: '', stderr: `Unknown agent: ${agent}. Supported: claude-code, openclaw, codex`, exitCode: 1 };
}

export function runPluginUninstall(agent: string): { stdout: string; stderr: string; exitCode: number } {
  if (agent === 'claude-code') {
    return uninstallClaudeCodePlugin();
  } else if (agent === 'openclaw') {
    return uninstallOpenClawPlugin();
  } else if (agent === 'codex') {
    return uninstallCodexPlugin();
  }
  return { stdout: '', stderr: `Unknown agent: ${agent}. Supported: claude-code, openclaw, codex`, exitCode: 1 };
}

export function runPluginStatus(): { stdout: string; exitCode: number } {
  const ccStatus = getClaudeCodePluginStatus();
  const ocStatus = getOpenClawPluginStatus();
  const cxStatus = getCodexPluginStatus();

  const ccLine = ccStatus.installed
    ? `Claude Code hook: ✔ installed (Stop → ${ccStatus.hookPath})`
    : `Claude Code hook: ✗ not installed (run: box0 plugin install claude-code)`;

  const ocLine = ocStatus.installed
    ? `OpenClaw plugin: ✔ installed (${ocStatus.extensionDir}/)`
    : `OpenClaw plugin: ✗ not installed (run: box0 plugin install openclaw)`;

  const cxLine = cxStatus.installed
    ? `Codex notify:    ✔ installed (notify → ${cxStatus.configPath})`
    : `Codex notify:    ✗ not installed (run: box0 plugin install codex)`;

  return { stdout: `${ccLine}\n${ocLine}\n${cxLine}\n`, exitCode: 0 };
}

export const pluginCommand = new Command('plugin')
  .description('Manage agent plugins (auto-sync hooks)');

pluginCommand
  .command('install <agent>')
  .description('Install a plugin hook (agent: claude-code | openclaw | codex)')
  .action((agent: string) => {
    const result = runPluginInstall(agent);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });

pluginCommand
  .command('uninstall <agent>')
  .description('Uninstall a plugin hook (agent: claude-code | openclaw | codex)')
  .action((agent: string) => {
    const result = runPluginUninstall(agent);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });

pluginCommand
  .command('status')
  .description('Show plugin installation status')
  .action(() => {
    const result = runPluginStatus();
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });
