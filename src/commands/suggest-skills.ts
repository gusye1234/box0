import { Command } from 'commander';
import chalk from 'chalk';
import { AgentSource } from '../types';
import { suggestSkills, SkillSuggestion } from '../models/skills';

const VALID_AGENTS = ['claude-code', 'openclaw', 'codex', 'chatgpt'] as const;

export interface RunSuggestSkillsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runSuggestSkills(opts: {
  agent?: string;
  days?: string | number;
  top?: string | number;
  minFreq?: string | number;
  json?: boolean;
}): RunSuggestSkillsResult {
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

  // Validate min-freq
  const minFreqRaw = opts.minFreq ?? 2;
  const minFreq = typeof minFreqRaw === 'number' ? minFreqRaw : Number(String(minFreqRaw));
  if (isNaN(minFreq) || minFreq <= 0 || !Number.isInteger(minFreq)) {
    return { stdout: '', stderr: 'Error: --min-freq must be a positive integer\n', exitCode: 1 };
  }

  const agent = opts.agent as AgentSource | undefined;

  const suggestions = suggestSkills({ days, agent, limit: top, minFreq });

  // JSON output
  if (opts.json) {
    return { stdout: JSON.stringify(suggestions, null, 2) + '\n', stderr: '', exitCode: 0 };
  }

  // Plain text output
  let out = '';

  // Header
  if (agent) {
    out += chalk.bold(`=== Skill Suggestions (${agent}, last ${days} days) ===`) + '\n';
  } else {
    out += chalk.bold('=== Skill Suggestions ===') + '\n';
  }

  if (suggestions.length === 0) {
    out += '\nNo workflow patterns found. Import more sessions or widen the analysis window with --days.\n';
    return { stdout: out, stderr: '', exitCode: 0 };
  }

  out += `\nFound ${suggestions.length} workflow pattern${suggestions.length === 1 ? '' : 's'} worth turning into skill${suggestions.length === 1 ? '' : 's'}:\n`;

  const PATTERN_LABELS: Record<SkillSuggestion['pattern'], string> = {
    'high-frequency': 'High-frequency task \u2014 you repeat this often across sessions.',
    'high-effort': 'High-effort task \u2014 sessions are significantly longer than average.',
    'cross-agent': 'Cross-agent task \u2014 same task appears across multiple agents.',
    'routine': 'Routine task \u2014 low effort but very frequent.',
  };

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const num = `${i + 1}.`;
    out += `\n  ${num} ${chalk.bold('"' + s.title + '"')}\n`;
    out += `     ${chalk.dim('Frequency:')}  ${s.frequency} session${s.frequency === 1 ? '' : 's'} (last ${days} days)\n`;
    out += `     ${chalk.dim('Agent:')}      ${s.agents.join(', ')}\n`;
    out += `     ${chalk.dim('Avg msgs:')}   ${s.avgMessages}\n`;
    out += `     ${chalk.dim('Pattern:')}    ${PATTERN_LABELS[s.pattern]}\n`;
    out += `     ${chalk.dim('Suggestion:')} ${chalk.dim(s.suggestion)}\n`;
  }

  out += `\nNo more suggestions.${days < 90 ? ' Run `box0 suggest-skills --days 90` to widen the analysis window.' : ''}\n`;

  return { stdout: out, stderr: '', exitCode: 0 };
}

export const suggestSkillsCommand = new Command('suggest-skills')
  .description('Analyze session history and suggest workflows worth turning into reusable skills')
  .option('-a, --agent <agent>', 'Filter by agent (claude-code, openclaw, codex, chatgpt)')
  .option('-d, --days <number>', 'Time window for analysis (in days)', '30')
  .option('-n, --top <number>', 'Max suggestions to show', '10')
  .option('--min-freq <number>', 'Minimum session frequency to consider a pattern', '2')
  .option('--json', 'Output as JSON array')
  .action((options: { agent?: string; days: string; top: string; minFreq: string; json?: boolean }) => {
    const result = runSuggestSkills(options);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });
