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

describe('stats model', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-stats-test-${crypto.randomBytes(4).toString('hex')}`);
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

  // --- getOverview ---

  test('getOverview() on empty DB returns zeros', () => {
    const { getOverview } = require('../models/stats');
    const result = getOverview();
    assert.deepStrictEqual(result, { totalSessions: 0, totalMessages: 0, avgMessagesPerSession: 0 });
  });

  test('getOverview() with sessions returns correct totals', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { getOverview } = require('../models/stats');
    const s1 = makeSession();
    const s2 = makeSession();
    const s3 = makeSession();
    insertSession(s1);
    insertSession(s2);
    insertSession(s3);
    incrementMessageCount(s1.id, 10);
    incrementMessageCount(s2.id, 20);
    incrementMessageCount(s3.id, 30);
    const result = getOverview();
    assert.strictEqual(result.totalSessions, 3);
    assert.strictEqual(result.totalMessages, 60);
    assert.strictEqual(result.avgMessagesPerSession, 20);
  });

  test('getOverview() with agent filter returns only that agent', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { getOverview } = require('../models/stats');
    const s1 = makeSession({ agent: 'claude-code' });
    const s2 = makeSession({ agent: 'openclaw' });
    insertSession(s1);
    insertSession(s2);
    incrementMessageCount(s1.id, 10);
    incrementMessageCount(s2.id, 20);
    const result = getOverview('claude-code');
    assert.strictEqual(result.totalSessions, 1);
    assert.strictEqual(result.totalMessages, 10);
    assert.strictEqual(result.avgMessagesPerSession, 10);
  });

  // --- getAgentDistribution ---

  test('getAgentDistribution() returns entries sorted by count DESC', () => {
    const { insertSession } = require('../models/session');
    const { getAgentDistribution } = require('../models/stats');
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'openclaw' }));
    insertSession(makeSession({ agent: 'codex' }));
    insertSession(makeSession({ agent: 'codex' }));
    const result = getAgentDistribution();
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].agent, 'claude-code');
    assert.strictEqual(result[0].count, 3);
    assert.strictEqual(result[1].agent, 'codex');
    assert.strictEqual(result[1].count, 2);
    assert.strictEqual(result[2].agent, 'openclaw');
    assert.strictEqual(result[2].count, 1);
  });

  test('getAgentDistribution() on empty DB returns empty array', () => {
    const { getAgentDistribution } = require('../models/stats');
    const result = getAgentDistribution();
    assert.deepStrictEqual(result, []);
  });

  // --- getActivityStats ---

  test('getActivityStats() counts only sessions within window', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { getActivityStats } = require('../models/stats');
    const now = Date.now();
    const recent = makeSession({ created_at: now - 5 * 86400000, updated_at: now });
    const old = makeSession({ created_at: now - 60 * 86400000, updated_at: now - 60 * 86400000 });
    insertSession(recent);
    insertSession(old);
    incrementMessageCount(recent.id, 10);
    incrementMessageCount(old.id, 20);
    const result = getActivityStats(30);
    assert.strictEqual(result.sessions, 1);
    assert.strictEqual(result.messages, 10);
  });

  test('getActivityStats() excludes sessions older than window', () => {
    const { insertSession } = require('../models/session');
    const { getActivityStats } = require('../models/stats');
    const now = Date.now();
    insertSession(makeSession({ created_at: now - 60 * 86400000, updated_at: now - 60 * 86400000 }));
    const result = getActivityStats(30);
    assert.strictEqual(result.sessions, 0);
    assert.strictEqual(result.messages, 0);
  });

  test('getActivityStats() returns correct mostActiveDay', () => {
    const { insertSession } = require('../models/session');
    const { getActivityStats } = require('../models/stats');
    const now = Date.now();
    // Create 3 sessions on the same day
    const dayMs = 86400000;
    const targetDay = now - 2 * dayMs;
    // Round to midnight
    const midnight = new Date(targetDay);
    midnight.setHours(12, 0, 0, 0);
    const t = midnight.getTime();
    insertSession(makeSession({ created_at: t }));
    insertSession(makeSession({ created_at: t + 1000 }));
    insertSession(makeSession({ created_at: t + 2000 }));
    // One session on a different day
    insertSession(makeSession({ created_at: now }));
    const result = getActivityStats(30);
    assert.ok(result.mostActiveDay !== null);
    assert.strictEqual(result.mostActiveDay!.count, 3);
  });

  test('getActivityStats() returns mostActiveDay null when no sessions in window', () => {
    const { getActivityStats } = require('../models/stats');
    const result = getActivityStats(30);
    assert.strictEqual(result.mostActiveDay, null);
  });

  // --- getTopTasks ---

  test('getTopTasks() groups sessions with same normalized title', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    insertSession(makeSession({ title: 'Fix Bug' }));
    insertSession(makeSession({ title: 'fix bug' }));
    insertSession(makeSession({ title: '  Fix Bug  ' }));
    insertSession(makeSession({ title: 'Other task' }));
    const result = getTopTasks(5);
    assert.strictEqual(result[0].count, 3);
    assert.strictEqual(result[1].count, 1);
  });

  test('getTopTasks() excludes sessions with null titles', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    insertSession(makeSession({ title: null as any }));
    insertSession(makeSession({ title: 'Real task' }));
    const result = getTopTasks(10);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, 'Real task');
  });

  test('getTopTasks() respects limit parameter', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    insertSession(makeSession({ title: 'Task A' }));
    insertSession(makeSession({ title: 'Task B' }));
    insertSession(makeSession({ title: 'Task C' }));
    const result = getTopTasks(2);
    assert.strictEqual(result.length, 2);
  });

  test('getTopTasks() with agent filter only shows that agent tasks', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    insertSession(makeSession({ agent: 'claude-code', title: 'Task A' }));
    insertSession(makeSession({ agent: 'openclaw', title: 'Task B' }));
    const result = getTopTasks(10, undefined, 'claude-code');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, 'Task A');
  });

  test('getTopTasks() title normalization treats "Fix Bug" and "fix bug" as same', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    insertSession(makeSession({ title: 'Fix Bug' }));
    insertSession(makeSession({ title: 'fix bug' }));
    const result = getTopTasks(10);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].count, 2);
  });

  test('getTopTasks() with days filter only considers recent sessions', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    const now = Date.now();
    insertSession(makeSession({ title: 'Recent', created_at: now }));
    insertSession(makeSession({ title: 'Old', created_at: now - 60 * 86400000 }));
    const result = getTopTasks(10, 30);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, 'Recent');
  });

  test('getTopTasks() display title comes from most recently created session', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    const now = Date.now();
    insertSession(makeSession({ title: 'fix bug', created_at: now - 10000 }));
    insertSession(makeSession({ title: 'Fix Bug', created_at: now }));
    const result = getTopTasks(10);
    assert.strictEqual(result[0].title, 'Fix Bug');
  });

  test('getTopTasks() latestAgent reflects the agent of the most recent session', () => {
    const { insertSession } = require('../models/session');
    const { getTopTasks } = require('../models/stats');
    const now = Date.now();
    insertSession(makeSession({ title: 'fix bug', agent: 'openclaw', created_at: now - 10000 }));
    insertSession(makeSession({ title: 'Fix Bug', agent: 'claude-code', created_at: now }));
    const result = getTopTasks(10);
    assert.strictEqual(result[0].latestAgent, 'claude-code');
  });
});
