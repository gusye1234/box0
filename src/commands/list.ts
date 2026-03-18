import { Command } from 'commander';
import chalk from 'chalk';
import * as session from '../models/session';
import { AgentSource } from '../types';
import { formatDateTime, agentTag } from '../lib/format';

const VALID_AGENTS = ['claude-code', 'openclaw', 'codex', 'chatgpt'] as const;
const VALID_SORTS = ['updated', 'created'] as const;

export interface RunListResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runList(opts: { agent?: string; limit?: string | number; sort?: string }): RunListResult {
  // Validate agent
  if (opts.agent !== undefined && !(VALID_AGENTS as readonly string[]).includes(opts.agent)) {
    return {
      stdout: '',
      stderr: `Error: Unknown agent "${opts.agent}". Valid agents: claude-code, openclaw, codex, chatgpt\n`,
      exitCode: 1,
    };
  }

  // Validate limit
  const limitRaw = opts.limit ?? 20;
  const limit = typeof limitRaw === 'number' ? limitRaw : parseInt(String(limitRaw), 10);
  if (isNaN(limit) || limit <= 0) {
    return { stdout: '', stderr: 'Error: --limit must be a positive integer\n', exitCode: 1 };
  }

  // Validate sort
  const sortRaw = opts.sort ?? 'updated';
  if (!(VALID_SORTS as readonly string[]).includes(sortRaw)) {
    return { stdout: '', stderr: `Error: --sort must be "updated" or "created"\n`, exitCode: 1 };
  }
  const sort = sortRaw as 'updated' | 'created';

  const agent = opts.agent as AgentSource | undefined;

  // Fetch sessions
  const rows = agent
    ? session.findByAgent(agent, limit, sort)
    : session.listAll(limit, sort);

  // Get true total (unaffected by --limit)
  const total = agent ? session.countByAgent(agent) : session.count();

  // Build header
  const agentPart = agent ? `  ·  agent: ${agent}` : '';
  let stdout = chalk.bold(`Sessions (${total} total, showing ${limit})${agentPart}  ·  sorted by: ${sort}`) + '\n';

  if (rows.length === 0) {
    stdout = 'No sessions found. Run `box0 import` to get started.\n';
    return { stdout, stderr: '', exitCode: 0 };
  }

  stdout += '\n';

  for (const row of rows) {
    const dateMs = sort === 'created' ? row.created_at : row.updated_at;
    const date = chalk.dim(formatDateTime(dateMs));
    const tag = agentTag(row.agent);
    const rawTitle = row.title ?? '(untitled)';
    const title = rawTitle.length > 40 ? rawTitle.slice(0, 40) : rawTitle.padEnd(40);
    const msgCount = chalk.dim(String(row.message_count).padStart(4) + ' msgs');
    const idPrefix = chalk.dim(row.id.slice(0, 8) + '…');
    stdout += `${date}  ${tag}  ${title}  ${msgCount}  ${idPrefix}\n`;
  }

  return { stdout, stderr: '', exitCode: 0 };
}

export const listCommand = new Command('list')
  .description('List imported sessions')
  .option('-a, --agent <agent>', 'Filter by agent (claude-code, openclaw, codex, chatgpt)')
  .option('-n, --limit <number>', 'Maximum number of results', '20')
  .option('--sort <field>', 'Sort by field: updated or created', 'updated')
  .action((options: { agent?: string; limit: string; sort?: string }) => {
    const result = runList(options);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });
