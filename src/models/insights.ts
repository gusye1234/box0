import { getDb } from '../lib/db';
import { AgentSource } from '../types';
import { getActivityStats, getTopTasks } from './stats';
import { suggestSkills, SkillSuggestion } from './skills';

export interface InsightReport {
  overview: {
    sessions: number;
    messages: number;
    avgMessagesPerSession: number;
    agents: Array<{ agent: AgentSource; count: number }> | null; // null when agent-filtered
    mostActiveDay: { date: string; count: number } | null;
  };
  trends: {
    sessionsDelta: number | null;  // ratio change vs previous period
    messagesDelta: number | null;  // ratio change vs previous period
    busiestDayOfWeek: { day: string; avgSessions: number } | null;
  };
  topTasks: Array<{
    title: string;
    count: number;
    latestAgent: AgentSource;
  }>;
  skillSuggestions: SkillSuggestion[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function getAgentDistributionInWindow(days: number): Array<{ agent: AgentSource; count: number }> {
  const db = getDb();
  const cutoff = Date.now() - days * 86400000;
  return db.prepare(
    `SELECT agent, COUNT(*) AS count FROM sessions WHERE created_at >= ? GROUP BY agent ORDER BY count DESC`
  ).all(cutoff) as Array<{ agent: AgentSource; count: number }>;
}

export function getPeriodComparison(days: number, agent?: AgentSource): {
  sessionsDelta: number | null;
  messagesDelta: number | null;
} {
  const db = getDb();
  const now = Date.now();
  const currentCutoff = now - days * 86400000;
  const previousCutoff = now - 2 * days * 86400000;

  const agentFilter = agent ? ' AND agent = ?' : '';

  // Current period: [currentCutoff, now]
  const currentRow = db.prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(message_count), 0) AS messages
     FROM sessions WHERE created_at >= ?${agentFilter}`
  ).get(...(agent ? [currentCutoff, agent] : [currentCutoff])) as { sessions: number; messages: number };

  // Previous period: [previousCutoff, currentCutoff)
  const previousRow = db.prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(message_count), 0) AS messages
     FROM sessions WHERE created_at >= ? AND created_at < ?${agentFilter}`
  ).get(...(agent ? [previousCutoff, currentCutoff, agent] : [previousCutoff, currentCutoff])) as { sessions: number; messages: number };

  if (previousRow.sessions === 0) {
    return { sessionsDelta: null, messagesDelta: null };
  }

  const sessionsDelta = (currentRow.sessions - previousRow.sessions) / previousRow.sessions;
  const messagesDelta = (currentRow.messages - previousRow.messages) / previousRow.messages;

  return {
    sessionsDelta: Math.round(sessionsDelta * 100) / 100,
    messagesDelta: Math.round(messagesDelta * 100) / 100,
  };
}

export function getBusiestDayOfWeek(days: number, agent?: AgentSource): {
  day: string;
  avgSessions: number;
} | null {
  const db = getDb();
  const cutoff = Date.now() - days * 86400000;
  const agentFilter = agent ? ' AND agent = ?' : '';
  const params = agent ? [cutoff, agent] : [cutoff];

  const row = db.prepare(
    `SELECT strftime('%w', created_at / 1000, 'unixepoch', 'localtime') AS dow, COUNT(*) AS cnt
     FROM sessions WHERE created_at >= ?${agentFilter}
     GROUP BY dow ORDER BY cnt DESC, dow ASC LIMIT 1`
  ).get(...params) as { dow: string; cnt: number } | undefined;

  if (!row) return null;

  const dowNum = parseInt(row.dow, 10);

  // Count actual occurrences of this weekday in the time window
  const now = Date.now();
  const startDate = new Date(now - days * 86400000);
  const endDate = new Date(now);
  let weekdayCount = 0;
  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() === dowNum) weekdayCount++;
    d.setDate(d.getDate() + 1);
  }

  const avgSessions = weekdayCount > 0
    ? Math.round((row.cnt / weekdayCount) * 10) / 10
    : row.cnt;

  return {
    day: DAY_NAMES[dowNum],
    avgSessions,
  };
}

export function generateInsight(opts: {
  days?: number;
  agent?: AgentSource;
  limit?: number;
}): InsightReport {
  const days = opts.days ?? 30;
  const agent = opts.agent;
  const limit = opts.limit ?? 5;

  const activity = getActivityStats(days, agent);
  const agents = agent ? null : getAgentDistributionInWindow(days);
  const comparison = getPeriodComparison(days, agent);
  const busiestDay = getBusiestDayOfWeek(days, agent);
  const topTasks = getTopTasks(limit, days, agent);
  const skillSuggestions = suggestSkills({ days, agent, limit });

  return {
    overview: {
      sessions: activity.sessions,
      messages: activity.messages,
      avgMessagesPerSession: activity.avgMessagesPerSession,
      agents,
      mostActiveDay: activity.mostActiveDay,
    },
    trends: {
      sessionsDelta: comparison.sessionsDelta,
      messagesDelta: comparison.messagesDelta,
      busiestDayOfWeek: busiestDay,
    },
    topTasks,
    skillSuggestions,
  };
}
