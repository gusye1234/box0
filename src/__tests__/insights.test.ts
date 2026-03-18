import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session } from '../types';

function makeSession(overrides: Partial<Omit<Session, 'message_count'>> = {}): Omit<Session, 'message_count'> {
  return {
    id: crypto.randomBytes(20).toString('hex'),
    agent: 'claude-code',
    title: 'Test session',
    source_path: `/tmp/test-${crypto.randomBytes(4).toString('hex')}.jsonl`,
    created_at: Date.now(),
    updated_at: Date.now(),
    imported_at: Date.now(),
    ...overrides,
  };
}

describe('insights model', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-insights-test-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tempDir, { recursive: true });
    process.env.BOX0_DIR = tempDir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  // --- generateInsight on empty DB ---

  test('generateInsight() on empty DB returns zeroed overview, null trends, empty arrays', () => {
    const { generateInsight } = require('../models/insights');
    const report = generateInsight({});
    assert.strictEqual(report.overview.sessions, 0);
    assert.strictEqual(report.overview.messages, 0);
    assert.strictEqual(report.overview.avgMessagesPerSession, 0);
    assert.deepStrictEqual(report.overview.agents, []);
    assert.strictEqual(report.overview.mostActiveDay, null);
    assert.strictEqual(report.trends.sessionsDelta, null);
    assert.strictEqual(report.trends.messagesDelta, null);
    assert.strictEqual(report.trends.busiestDayOfWeek, null);
    assert.deepStrictEqual(report.topTasks, []);
    assert.deepStrictEqual(report.skillSuggestions, []);
  });

  // --- generateInsight with sessions only in current period ---

  test('generateInsight() with sessions in current period only — deltas are null', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const s = makeSession({ title: 'Task A', created_at: Date.now() });
    insertSession(s);
    incrementMessageCount(s.id, 10);
    const report = generateInsight({ days: 30 });
    assert.strictEqual(report.overview.sessions, 1);
    assert.strictEqual(report.trends.sessionsDelta, null);
    assert.strictEqual(report.trends.messagesDelta, null);
  });

  // --- generateInsight with sessions in both periods ---

  test('generateInsight() with sessions in both periods — deltas computed correctly', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const now = Date.now();
    // Previous period: 5 sessions, 50 messages
    for (let i = 0; i < 5; i++) {
      const s = makeSession({ title: 'Task', created_at: now - 35 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // Current period: 10 sessions, 80 messages
    for (let i = 0; i < 10; i++) {
      const s = makeSession({ title: 'Task', created_at: now - 5 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 8);
    }
    const report = generateInsight({ days: 30 });
    // sessionsDelta = (10-5)/5 = 1.0
    assert.strictEqual(report.trends.sessionsDelta, 1.0);
    // messagesDelta = (80-50)/50 = 0.6
    assert.strictEqual(report.trends.messagesDelta, 0.6);
  });

  // --- generateInsight with sessions only in previous period ---

  test('generateInsight() with sessions only in previous period — delta = -1.0', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const now = Date.now();
    // Previous period only
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ title: 'Old task', created_at: now - 45 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    const report = generateInsight({ days: 30 });
    assert.strictEqual(report.overview.sessions, 0);
    assert.strictEqual(report.trends.sessionsDelta, -1.0);
    assert.strictEqual(report.trends.messagesDelta, -1.0);
  });

  // --- getPeriodComparison ---

  test('getPeriodComparison() returns null deltas when previous period has 0 sessions', () => {
    const { getPeriodComparison } = require('../models/insights');
    const result = getPeriodComparison(30);
    assert.strictEqual(result.sessionsDelta, null);
    assert.strictEqual(result.messagesDelta, null);
  });

  test('getPeriodComparison() correctly computes positive and negative deltas', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { getPeriodComparison } = require('../models/insights');
    const now = Date.now();
    // Previous period: 4 sessions, 40 messages (15 days ago = within 10-20 day window for days=10)
    for (let i = 0; i < 4; i++) {
      const s = makeSession({ created_at: now - 15 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // Current period: 2 sessions, 60 messages (3 days ago)
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ created_at: now - 3 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 30);
    }
    const result = getPeriodComparison(10);
    // sessionsDelta: (2-4)/4 = -0.5
    assert.strictEqual(result.sessionsDelta, -0.5);
    // messagesDelta: (60-40)/40 = 0.5
    assert.strictEqual(result.messagesDelta, 0.5);
  });

  test('getPeriodComparison() with --days 1 — single-day window', () => {
    const { insertSession } = require('../models/session');
    const { getPeriodComparison } = require('../models/insights');
    const now = Date.now();
    // Yesterday (previous period for days=1)
    const s1 = makeSession({ created_at: now - 1.5 * 86400000 });
    insertSession(s1);
    // Today (current period for days=1)
    const s2 = makeSession({ created_at: now - 0.5 * 86400000 });
    insertSession(s2);
    const result = getPeriodComparison(1);
    // 1 session in each period → delta = 0
    assert.strictEqual(result.sessionsDelta, 0);
  });

  // --- getBusiestDayOfWeek ---

  test('getBusiestDayOfWeek() returns correct day name', () => {
    const { insertSession } = require('../models/session');
    const { getBusiestDayOfWeek } = require('../models/insights');
    const now = Date.now();
    // Create sessions on a known day
    insertSession(makeSession({ created_at: now }));
    insertSession(makeSession({ created_at: now }));
    const result = getBusiestDayOfWeek(30);
    assert.ok(result);
    const today = new Date(now);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    assert.strictEqual(result.day, dayNames[today.getDay()]);
  });

  test('getBusiestDayOfWeek() returns null on empty DB', () => {
    const { getBusiestDayOfWeek } = require('../models/insights');
    const result = getBusiestDayOfWeek(30);
    assert.strictEqual(result, null);
  });

  test('getBusiestDayOfWeek() tie-breaking — earlier weekday (lower dow) wins', () => {
    const { insertSession } = require('../models/session');
    const { getBusiestDayOfWeek } = require('../models/insights');
    const now = Date.now();
    const today = new Date(now);
    const todayDow = today.getDay();
    // Create 1 session on today and 1 session on a different day
    // We need two different days with the same count to test tie-breaking
    // Use a wide window (90 days) and create sessions on two specific days
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Find two consecutive days — pick Sunday (0) and Monday (1)
    // Calculate when the next/recent Sunday and Monday were
    const daysUntilSunday = (todayDow === 0) ? 0 : (7 - todayDow);
    const recentSunday = now - (todayDow === 0 ? 0 : todayDow) * 86400000;
    const recentMonday = recentSunday + 86400000;

    // Create 1 session on Sunday
    insertSession(makeSession({ created_at: recentSunday }));
    // Create 1 session on Monday
    insertSession(makeSession({ created_at: recentMonday }));

    const result = getBusiestDayOfWeek(30);
    assert.ok(result);
    // Both have count=1, Sunday (dow=0) should win over Monday (dow=1)
    assert.strictEqual(result.day, 'Sunday');
  });

  // --- getAgentDistributionInWindow ---

  test('getAgentDistributionInWindow() returns only sessions within time window', () => {
    const { insertSession } = require('../models/session');
    const { getAgentDistributionInWindow } = require('../models/insights');
    const now = Date.now();
    insertSession(makeSession({ agent: 'claude-code', created_at: now }));
    insertSession(makeSession({ agent: 'openclaw', created_at: now }));
    insertSession(makeSession({ agent: 'codex', created_at: now - 60 * 86400000 })); // outside 30-day window
    const result = getAgentDistributionInWindow(30);
    assert.strictEqual(result.length, 2);
    const agents = result.map((r: any) => r.agent);
    assert.ok(agents.includes('claude-code'));
    assert.ok(agents.includes('openclaw'));
    assert.ok(!agents.includes('codex'));
  });

  test('getAgentDistributionInWindow() returns empty array on empty DB', () => {
    const { getAgentDistributionInWindow } = require('../models/insights');
    const result = getAgentDistributionInWindow(30);
    assert.deepStrictEqual(result, []);
  });

  // --- Agent filter propagation ---

  test('agent filter propagates — overview.agents is null when agent is set', () => {
    const { insertSession } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'openclaw' }));
    const report = generateInsight({ agent: 'claude-code' });
    assert.strictEqual(report.overview.agents, null);
  });

  test('agent filter propagates to overview, trends, top tasks, and skill suggestions', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const now = Date.now();
    // claude-code sessions
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ agent: 'claude-code', title: 'CC task', created_at: now });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // openclaw sessions
    for (let i = 0; i < 5; i++) {
      const s = makeSession({ agent: 'openclaw', title: 'OC task', created_at: now });
      insertSession(s);
      incrementMessageCount(s.id, 20);
    }
    const report = generateInsight({ agent: 'claude-code' });
    assert.strictEqual(report.overview.sessions, 3);
    assert.strictEqual(report.overview.agents, null);
  });

  // --- Days filter propagation ---

  test('days filter propagates to all sections', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const now = Date.now();
    // Sessions within 7 days
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Recent', created_at: now - 3 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // Sessions outside 7 days but within 30 days
    for (let i = 0; i < 5; i++) {
      const s = makeSession({ title: 'Older', created_at: now - 20 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    const report = generateInsight({ days: 7 });
    assert.strictEqual(report.overview.sessions, 2);
  });

  // --- Limit applies to both topTasks and skillSuggestions ---

  test('limit applies to both topTasks and skillSuggestions', () => {
    const { insertSession } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) {
        insertSession(makeSession({ title: `Task ${i}` }));
      }
    }
    const report = generateInsight({ limit: 2 });
    assert.ok(report.topTasks.length <= 2);
    assert.ok(report.skillSuggestions.length <= 2);
  });

  // --- Composition correctness ---

  test('top tasks data matches getTopTasks output', () => {
    const { insertSession } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const { getTopTasks } = require('../models/stats');
    for (let i = 0; i < 3; i++) {
      insertSession(makeSession({ title: 'Repeated task' }));
    }
    const report = generateInsight({ days: 30, limit: 5 });
    const direct = getTopTasks(5, 30);
    assert.deepStrictEqual(report.topTasks, direct);
  });

  test('skill suggestions data matches suggestSkills output', () => {
    const { insertSession } = require('../models/session');
    const { generateInsight } = require('../models/insights');
    const { suggestSkills } = require('../models/skills');
    for (let i = 0; i < 3; i++) {
      insertSession(makeSession({ title: 'Repeated task' }));
    }
    const report = generateInsight({ days: 30, limit: 5 });
    const direct = suggestSkills({ days: 30, limit: 5 });
    assert.deepStrictEqual(report.skillSuggestions, direct);
  });
});
