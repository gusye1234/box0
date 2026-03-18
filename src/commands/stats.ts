import { Command } from 'commander';
import { AgentSource } from '../types';
import * as statsModel from '../models/stats';

const VALID_AGENTS = ['claude-code', 'openclaw', 'codex', 'chatgpt'] as const;

export interface RunStatsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function runStats(opts: { agent?: string; days?: string | number; top?: string | number }): RunStatsResult {
  // Validate agent
  if (opts.agent !== undefined && !(VALID_AGENTS as readonly string[]).includes(opts.agent)) {
    return {
      stdout: '',
      stderr: `Error: Unknown agent "${opts.agent}". Valid agents: ${VALID_AGENTS.join(', ')}\n`,
      exitCode: 1,
    };
  }

  // Validate days
  const daysRaw = opts.days ?? 30;
  const days = typeof daysRaw === 'number' ? daysRaw : Number(String(daysRaw));
  if (isNaN(days) || days <= 0 || !Number.isInteger(days)) {
    return { stdout: '', stderr: 'Error: --days must be a positive integer\n', exitCode: 1 };
  }

  // Validate top
  const topRaw = opts.top ?? 10;
  const top = typeof topRaw === 'number' ? topRaw : Number(String(topRaw));
  if (isNaN(top) || top <= 0 || !Number.isInteger(top)) {
    return { stdout: '', stderr: 'Error: --top must be a positive integer\n', exitCode: 1 };
  }

  const agent = opts.agent as AgentSource | undefined;

  // Get overview (always all-time)
  const overview = statsModel.getOverview(agent);

  // Empty DB case
  if (overview.totalSessions === 0) {
    const msg = agent
      ? `No sessions found for agent "${agent}".\n`
      : 'No sessions found. Run `box0 import` to get started.\n';
    return { stdout: msg, stderr: '', exitCode: 0 };
  }

  const agentDistribution = agent ? null : statsModel.getAgentDistribution();
  const activity = statsModel.getActivityStats(days, agent);
  const topTasks = statsModel.getTopTasks(top, days, agent);

  // Build output
  let out = '';

  // Header
  if (agent) {
    out += `=== Box0 Stats (${agent}) ===\n`;
  } else {
    out += '=== Box0 Stats ===\n';
  }

  // Overview section
  out += '\nOverview\n';
  out += `  Total sessions:   ${formatNumber(overview.totalSessions)}\n`;
  out += `  Total messages:   ${formatNumber(overview.totalMessages)}\n`;
  out += `  Avg msgs/session: ${overview.avgMessagesPerSession.toFixed(1)}\n`;

  if (agentDistribution && agentDistribution.length > 0) {
    const parts = agentDistribution.map((d) => `${d.agent} (${formatNumber(d.count)})`);
    out += `  Agents:           ${parts.join(', ')}\n`;
  }

  // Activity section
  out += `\nActivity (last ${days} days)\n`;
  out += `  Sessions:         ${formatNumber(activity.sessions)}\n`;
  out += `  Messages:         ${formatNumber(activity.messages)}\n`;
  out += `  Avg msgs/session: ${activity.avgMessagesPerSession.toFixed(1)}\n`;
  if (activity.mostActiveDay) {
    out += `  Most active day:  ${activity.mostActiveDay.date} (${formatNumber(activity.mostActiveDay.count)} sessions)\n`;
  }

  // Top Tasks section
  out += '\nTop Tasks (by frequency)\n';
  if (topTasks.length === 0) {
    out += '  No recurring tasks found.\n';
  } else {
    const maxIdx = String(topTasks.length).length;
    for (let i = 0; i < topTasks.length; i++) {
      const task = topTasks[i];
      const num = `${i + 1}.`.padEnd(maxIdx + 1);
      const titleStr = `"${task.title}"`;
      const countStr = `\u00d7 ${task.count} session${task.count === 1 ? '' : 's'}`;
      const agentTag = agent ? '' : `  [${task.latestAgent}]`;
      out += `  ${num} ${titleStr.padEnd(40)} ${countStr}${agentTag}\n`;
    }
  }

  return { stdout: out, stderr: '', exitCode: 0 };
}

export const statsCommand = new Command('stats')
  .description('Show session statistics and identify high-frequency tasks')
  .option('-a, --agent <agent>', 'Filter by agent (claude-code, openclaw, codex, chatgpt)')
  .option('-d, --days <number>', 'Time window for Activity section (in days)', '30')
  .option('-n, --top <number>', 'Max number of top tasks to show', '10')
  .action((options: { agent?: string; days: string; top: string }) => {
    const result = runStats(options);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });
