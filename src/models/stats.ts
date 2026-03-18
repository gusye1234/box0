import { getDb } from '../lib/db';
import { AgentSource } from '../types';

export function getOverview(agent?: AgentSource): {
  totalSessions: number;
  totalMessages: number;
  avgMessagesPerSession: number;
} {
  const db = getDb();
  const where = agent ? 'WHERE agent = ?' : '';
  const params = agent ? [agent] : [];
  const row = db.prepare(
    `SELECT COUNT(*) AS totalSessions, COALESCE(SUM(message_count), 0) AS totalMessages FROM sessions ${where}`
  ).get(...params) as { totalSessions: number; totalMessages: number };

  const avg = row.totalSessions > 0
    ? Math.round((row.totalMessages / row.totalSessions) * 10) / 10
    : 0;

  return {
    totalSessions: row.totalSessions,
    totalMessages: row.totalMessages,
    avgMessagesPerSession: avg,
  };
}

export function getAgentDistribution(): Array<{ agent: AgentSource; count: number }> {
  const db = getDb();
  return db.prepare(
    `SELECT agent, COUNT(*) AS count FROM sessions GROUP BY agent ORDER BY count DESC`
  ).all() as Array<{ agent: AgentSource; count: number }>;
}

export function getActivityStats(days: number, agent?: AgentSource): {
  sessions: number;
  messages: number;
  avgMessagesPerSession: number;
  mostActiveDay: { date: string; count: number } | null;
} {
  const db = getDb();
  const cutoff = Date.now() - days * 86400000;
  const agentFilter = agent ? ' AND agent = ?' : '';
  const params = agent ? [cutoff, agent] : [cutoff];

  const row = db.prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(message_count), 0) AS messages
     FROM sessions WHERE created_at >= ?${agentFilter}`
  ).get(...params) as { sessions: number; messages: number };

  const avg = row.sessions > 0
    ? Math.round((row.messages / row.sessions) * 10) / 10
    : 0;

  const dayRow = db.prepare(
    `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS cnt
     FROM sessions WHERE created_at >= ?${agentFilter}
     GROUP BY day ORDER BY cnt DESC, day DESC LIMIT 1`
  ).get(...params) as { day: string; cnt: number } | undefined;

  return {
    sessions: row.sessions,
    messages: row.messages,
    avgMessagesPerSession: avg,
    mostActiveDay: dayRow ? { date: dayRow.day, count: dayRow.cnt } : null,
  };
}

export function getTopTasks(limit: number, days?: number, agent?: AgentSource): Array<{
  title: string;
  count: number;
  latestAgent: AgentSource;
}> {
  const db = getDb();
  const conditions: string[] = ['title IS NOT NULL'];
  const params: (string | number)[] = [];
  const cutoff = days !== undefined ? Date.now() - days * 86400000 : undefined;

  if (cutoff !== undefined) {
    conditions.push('created_at >= ?');
    params.push(cutoff);
  }
  if (agent) {
    conditions.push('agent = ?');
    params.push(agent);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Use a CTE to get groups, then for each group find the most recent session's title and agent
  const sql = `
    WITH groups AS (
      SELECT LOWER(TRIM(title)) AS norm_title, COUNT(*) AS cnt
      FROM sessions
      ${where}
      GROUP BY norm_title
      ORDER BY cnt DESC, norm_title ASC
      LIMIT ?
    )
    SELECT
      g.cnt,
      s.title,
      s.agent
    FROM groups g
    JOIN sessions s ON s.id = (
      SELECT s2.id FROM sessions s2
      WHERE LOWER(TRIM(s2.title)) = g.norm_title
        ${cutoff !== undefined ? 'AND s2.created_at >= ?' : ''}
        ${agent ? 'AND s2.agent = ?' : ''}
      ORDER BY s2.created_at DESC
      LIMIT 1
    )
    ORDER BY g.cnt DESC, g.norm_title ASC
  `;

  // Build final params: [conditions params..., limit, subquery conditions params...]
  const finalParams: (string | number)[] = [...params, limit];
  // Subquery needs the same time/agent filters (reuse same cutoff)
  if (cutoff !== undefined) {
    finalParams.push(cutoff);
  }
  if (agent) {
    finalParams.push(agent);
  }

  const rows = db.prepare(sql).all(...finalParams) as Array<{
    cnt: number;
    title: string;
    agent: AgentSource;
  }>;

  return rows.map((r) => ({
    title: r.title,
    count: r.cnt,
    latestAgent: r.agent,
  }));
}
