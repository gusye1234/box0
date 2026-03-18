import { Command } from 'commander';
import chalk from 'chalk';
import Database from 'better-sqlite3';
import * as message from '../models/message';
import * as session from '../models/session';
import { getDb } from '../lib/db';
import { AgentSource } from '../types';

const VALID_AGENTS = ['claude-code', 'openclaw', 'codex', 'chatgpt'] as const;

export interface RunSearchResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runSearch(
  query: string,
  opts: { agent?: string; limit?: string | number }
): RunSearchResult {
  // Validate query
  if (query.trim() === '') {
    return { stdout: '', stderr: 'Error: Query must not be empty.\n', exitCode: 1 };
  }

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

  // Validate FTS5 query syntax. A direct query against the FTS table (without JOINs)
  // always evaluates MATCH, even when the underlying tables are empty. The joined query
  // in message.search() short-circuits on empty tables and never throws in that case.
  try {
    getDb().prepare('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?').get(query);
  } catch (err) {
    if (err instanceof (Database as any).SqliteError) {
      return {
        stdout: '',
        stderr:
          'Error: Search failed — invalid FTS5 query syntax.\n' +
          'Tip: Use double quotes for phrase search, e.g.: box0 search \'"exact phrase"\'\n',
        exitCode: 1,
      };
    }
    return { stdout: '', stderr: `Error: ${(err as Error).message}\n`, exitCode: 1 };
  }

  // Run search
  let results;
  try {
    results = message.search(query, opts.agent as AgentSource | undefined, limit);
  } catch (err) {
    return {
      stdout: '',
      stderr: `Error: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }

  // Enrich results with session data; skip missing sessions
  const enriched: Array<{ agent: string; title: string; date: string; snippet: string; sessionId: string }> = [];
  for (const r of results) {
    const s = session.findById(r.session_id);
    if (s === undefined) continue;
    const title = s.title ?? '(untitled)';
    const date = new Date(s.created_at).toISOString().slice(0, 10);
    const snippet = r.snippet.replace(/<b>(.*?)<\/b>/g, (_: string, m: string) => chalk.bold(m));
    enriched.push({ agent: r.agent, title, date, snippet, sessionId: r.session_id });
  }

  // Build output
  let stdout = '';
  const agentNote = opts.agent ? ` (agent: ${opts.agent})` : '';

  if (enriched.length === 0) {
    stdout += `No results found for "${query}".\n`;
  } else {
    stdout += `\nFound ${enriched.length} result(s) for "${query}"${agentNote}\n`;
    for (const e of enriched) {
      stdout += `\n[${e.agent}]  ${e.title}  ·  ${e.date}\n`;
      stdout += `  ${e.snippet}\n`;
      stdout += `  session: ${e.sessionId}\n`;
    }
  }

  return { stdout, stderr: '', exitCode: 0 };
}

export const searchCommand = new Command('search')
  .description('Search agent context')
  .argument('<query>', 'Search query (supports FTS5 syntax: phrase search, prefix, boolean)')
  .option('-a, --agent <agent>', 'Filter by agent (claude-code, openclaw, codex, chatgpt)')
  .option('-n, --limit <number>', 'Max results (default: 20)', '20')
  .action((query: string, options: { agent?: string; limit?: string }) => {
    const result = runSearch(query, options);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });
