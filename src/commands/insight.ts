import { Command } from 'commander';
import chalk from 'chalk';
import { AgentSource } from '../types';
import { generateInsight, InsightReport } from '../models/insights';
import { getOverview } from '../models/stats';
import { formatNumber, formatDelta, sectionHeader } from '../lib/format';

const VALID_AGENTS = ['claude-code', 'openclaw', 'codex', 'chatgpt'] as const;

export interface RunInsightResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runInsight(opts: {
  agent?: string;
  days?: string | number;
  top?: string | number;
  json?: boolean;
}): RunInsightResult {
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
  const topRaw = opts.top ?? 5;
  const top = typeof topRaw === 'number' ? topRaw : Number(String(topRaw));
  if (isNaN(top) || top <= 0 || !Number.isInteger(top)) {
    return { stdout: '', stderr: 'Error: --top must be a positive integer\n', exitCode: 1 };
  }

  const agent = opts.agent as AgentSource | undefined;

  const report = generateInsight({ days, agent, limit: top });

  // Empty DB handling
  if (report.overview.sessions === 0) {
    // Check if there are any sessions at all (all-time)
    const allTime = getOverview(agent);
    if (allTime.totalSessions === 0) {
      // Truly empty
      if (opts.json) {
        return { stdout: JSON.stringify(report, null, 2) + '\n', stderr: '', exitCode: 0 };
      }
      const msg = agent
        ? `No sessions found for agent "${agent}". Run \`box0 import\` to get started.\n`
        : 'No sessions found. Run `box0 import` to get started.\n';
      return { stdout: msg, stderr: '', exitCode: 0 };
    } else {
      // Sessions exist but outside window
      if (opts.json) {
        return { stdout: JSON.stringify(report, null, 2) + '\n', stderr: '', exitCode: 0 };
      }
      const agentQualifier = agent ? ` for agent "${agent}"` : '';
      return {
        stdout: `No sessions found${agentQualifier} in the last ${days} days.\n`,
        stderr: '',
        exitCode: 0,
      };
    }
  }

  // JSON output
  if (opts.json) {
    return { stdout: JSON.stringify(report, null, 2) + '\n', stderr: '', exitCode: 0 };
  }

  // Plain text output
  let out = '';

  // Header
  if (agent) {
    out += chalk.bold(`=== Box0 Insight Report (${agent}, last ${days} days) ===`) + '\n';
  } else {
    out += chalk.bold(`=== Box0 Insight Report ===`) + '\n';
  }

  // Overview section
  out += '\n' + sectionHeader(`Overview (last ${days} days)`) + '\n';
  out += `  ${chalk.dim('Sessions:')}         ${formatNumber(report.overview.sessions)}\n`;
  out += `  ${chalk.dim('Messages:')}         ${formatNumber(report.overview.messages)}\n`;
  if (report.overview.agents && report.overview.agents.length > 0) {
    const parts = report.overview.agents.map((d) => `${d.agent} (${formatNumber(d.count)})`);
    out += `  ${chalk.dim('Agents:')}           ${parts.join(', ')}\n`;
  }
  out += `  ${chalk.dim('Avg msgs/session:')} ${report.overview.avgMessagesPerSession.toFixed(1)}\n`;
  if (report.overview.mostActiveDay) {
    out += `  ${chalk.dim('Most active day:')}  ${report.overview.mostActiveDay.date} (${formatNumber(report.overview.mostActiveDay.count)} sessions)\n`;
  }

  // Trends section
  out += '\n' + sectionHeader('Trends') + '\n';
  out += `  ${chalk.dim('vs previous ' + days + ' days:')} sessions ${formatDelta(report.trends.sessionsDelta)}, messages ${formatDelta(report.trends.messagesDelta)}\n`;
  if (report.trends.busiestDayOfWeek) {
    out += `  ${chalk.dim('Busiest day of week:')} ${report.trends.busiestDayOfWeek.day} (avg ${report.trends.busiestDayOfWeek.avgSessions.toFixed(1)} sessions)\n`;
  }

  // Top Recurring Tasks section
  out += '\n' + sectionHeader('Top Recurring Tasks') + '\n';
  if (report.topTasks.length === 0) {
    out += '  No recurring tasks found.\n';
  } else {
    const maxIdx = String(report.topTasks.length).length;
    for (let i = 0; i < report.topTasks.length; i++) {
      const task = report.topTasks[i];
      const num = `${i + 1}.`.padEnd(maxIdx + 1);
      const titleStr = `"${task.title}"`;
      const countStr = `\u00d7 ${task.count} session${task.count === 1 ? '' : 's'}`;
      const agentTagStr = agent ? '' : `  [${task.latestAgent}]`;
      out += `  ${num} ${titleStr.padEnd(40)} ${countStr}${agentTagStr}\n`;
    }
  }

  // Skill Suggestions section
  out += '\n' + sectionHeader('Skill Suggestions') + '\n';
  if (report.skillSuggestions.length === 0) {
    out += '  No skill suggestions found.\n';
  } else {
    for (let i = 0; i < report.skillSuggestions.length; i++) {
      const s = report.skillSuggestions[i];
      const patternLabel =
        s.pattern === 'high-frequency' ? 'High-frequency task' :
        s.pattern === 'high-effort' ? 'High-effort task' :
        s.pattern === 'cross-agent' ? 'Cross-agent task' :
        'Routine task';
      out += `  ${i + 1}. "${s.title}" — ${patternLabel}. ${s.suggestion}\n`;
    }
  }

  // Footer hints
  const agentFlag = agent ? ` --agent ${agent}` : '';
  out += `\nRun \`box0 stats${agentFlag}\` for detailed statistics.\n`;
  out += `Run \`box0 suggest-skills${agentFlag}\` for full skill analysis.\n`;

  return { stdout: out, stderr: '', exitCode: 0 };
}

export const insightCommand = new Command('insight')
  .description('Generate a high-level insight report combining session analytics and skill suggestions')
  .option('-a, --agent <agent>', 'Filter by agent (claude-code, openclaw, codex, chatgpt)')
  .option('-d, --days <number>', 'Time window for analysis (in days)', '30')
  .option('-n, --top <number>', 'Max items in recurring tasks and skill suggestions', '5')
  .option('--json', 'Output as JSON object')
  .action((options: { agent?: string; days: string; top: string; json?: boolean }) => {
    const result = runInsight(options);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });
