import { getDb } from '../lib/db';
import { AgentSource } from '../types';

export interface SkillSuggestion {
  title: string;
  frequency: number;
  agents: AgentSource[];
  avgMessages: number;
  pattern: 'high-frequency' | 'high-effort' | 'cross-agent' | 'routine';
  suggestion: string;
}

const SUGGESTION_TEXT: Record<SkillSuggestion['pattern'], string> = {
  'high-frequency':
    'Create a skill/prompt template that captures your standard steps so the agent can follow them without re-explaining each time.',
  'high-effort':
    'Create a structured debugging skill with predefined investigation steps to reduce per-session effort.',
  'cross-agent':
    'Standardize a skill usable by any agent, including your preferred patterns and conventions.',
  'routine':
    'Automate with a lightweight skill or hook that runs on every occurrence.',
};

export function suggestSkills(opts: {
  days?: number;
  agent?: AgentSource;
  limit?: number;
  minFreq?: number;
}): SkillSuggestion[] {
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 10;
  const minFreq = opts.minFreq ?? 2;
  const agent = opts.agent;

  const db = getDb();
  const cutoff = Date.now() - days * 86400000;

  const conditions: string[] = ['title IS NOT NULL', 'created_at >= ?'];
  const params: (string | number)[] = [cutoff];

  if (agent) {
    conditions.push('agent = ?');
    params.push(agent);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Compute filtered baseline average message count
  const baselineRow = db.prepare(
    `SELECT AVG(message_count) AS avg_msgs FROM sessions ${where}`
  ).get(...params) as { avg_msgs: number | null };
  const baselineAvg = baselineRow.avg_msgs ?? 0;

  // Main query: task groups with frequency, avg messages, agents, display title
  const sql = `
    WITH groups AS (
      SELECT
        LOWER(TRIM(title)) AS norm_title,
        COUNT(*) AS freq,
        AVG(message_count) AS avg_msgs,
        GROUP_CONCAT(DISTINCT agent) AS agents_csv
      FROM sessions
      ${where}
      GROUP BY norm_title
      HAVING freq >= ?
      ORDER BY freq DESC, avg_msgs DESC
    )
    SELECT
      g.norm_title,
      g.freq,
      g.avg_msgs,
      g.agents_csv,
      s.title AS display_title
    FROM groups g
    JOIN sessions s ON s.id = (
      SELECT s2.id FROM sessions s2
      WHERE LOWER(TRIM(s2.title)) = g.norm_title
        AND s2.created_at >= ?
        ${agent ? 'AND s2.agent = ?' : ''}
      ORDER BY s2.created_at DESC
      LIMIT 1
    )
    ORDER BY g.freq DESC, g.avg_msgs DESC
  `;

  // Build params: [where params..., minFreq, subquery params (cutoff, agent?)]
  const finalParams: (string | number)[] = [...params, minFreq, cutoff];
  if (agent) {
    finalParams.push(agent);
  }

  const rows = db.prepare(sql).all(...finalParams) as Array<{
    norm_title: string;
    freq: number;
    avg_msgs: number;
    agents_csv: string;
    display_title: string;
  }>;

  // Classify each group
  const results: SkillSuggestion[] = [];
  for (const row of rows) {
    const agents = row.agents_csv.split(',') as AgentSource[];
    const avgMessages = Math.round(row.avg_msgs * 10) / 10;

    // Priority: cross-agent > high-effort > routine > high-frequency
    let pattern: SkillSuggestion['pattern'];
    if (!agent && agents.length >= 2) {
      pattern = 'cross-agent';
    } else if (baselineAvg > 0 && avgMessages > baselineAvg * 1.5) {
      pattern = 'high-effort';
    } else if (baselineAvg > 0 && avgMessages < baselineAvg * 0.5) {
      pattern = 'routine';
    } else {
      pattern = 'high-frequency';
    }

    results.push({
      title: row.display_title,
      frequency: row.freq,
      agents,
      avgMessages,
      pattern,
      suggestion: SUGGESTION_TEXT[pattern],
    });
  }

  return results.slice(0, limit);
}
