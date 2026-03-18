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

describe('stats command (runStats)', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-stats-cmd-test-${crypto.randomBytes(4).toString('hex')}`);
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

  // --- Validation errors ---

  test('invalid agent returns exitCode 1', () => {
    const { runStats } = require('../commands/stats');
    const result = runStats({ agent: 'bogus' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Unknown agent'));
    assert.ok(result.stderr.includes('claude-code'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid days (non-integer string) returns exitCode 1', () => {
    const { runStats } = require('../commands/stats');
    const result = runStats({ days: 'abc' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid days (zero) returns exitCode 1', () => {
    const { runStats } = require('../commands/stats');
    const result = runStats({ days: '0' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
  });

  test('invalid days (float like 3.5) returns exitCode 1', () => {
    const { runStats } = require('../commands/stats');
    const result = runStats({ days: '3.5' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
  });

  test('invalid top (negative) returns exitCode 1', () => {
    const { runStats } = require('../commands/stats');
    const result = runStats({ top: '-1' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--top'));
  });

  // --- Empty DB ---

  test('empty DB shows no sessions message', () => {
    const { runStats } = require('../commands/stats');
    const result = runStats({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('No sessions found.'));
    assert.strictEqual(result.stderr, '');
  });

  // --- Default output ---

  test('default output contains Overview, Activity, Top Tasks sections', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runStats } = require('../commands/stats');
    const s = makeSession({ agent: 'claude-code', title: 'My task' });
    insertSession(s);
    incrementMessageCount(s.id, 42);
    const result = runStats({});
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    assert.ok(result.stdout.includes('=== Box0 Stats ==='));
    assert.ok(result.stdout.includes('Overview'));
    assert.ok(result.stdout.includes('Activity (last 30 days)'));
    assert.ok(result.stdout.includes('Top Tasks (by frequency)'));
  });

  // --- Agent filter ---

  test('agent filter shows agent name in header and no agent distribution line', () => {
    const { insertSession } = require('../models/session');
    const { runStats } = require('../commands/stats');
    insertSession(makeSession({ agent: 'claude-code', title: 'Task' }));
    insertSession(makeSession({ agent: 'openclaw', title: 'Task' }));
    const result = runStats({ agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('=== Box0 Stats (claude-code) ==='));
    assert.ok(!result.stdout.includes('Agents:'));
  });

  test('agent filter top tasks show no agent tag', () => {
    const { insertSession } = require('../models/session');
    const { runStats } = require('../commands/stats');
    insertSession(makeSession({ agent: 'claude-code', title: 'My task' }));
    const result = runStats({ agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    // Top tasks should not contain [claude-code] bracket tag
    const topSection = result.stdout.split('Top Tasks')[1];
    assert.ok(!topSection.includes('[claude-code]'));
  });

  // --- Days override ---

  test('days override shows custom day count in Activity header', () => {
    const { insertSession } = require('../models/session');
    const { runStats } = require('../commands/stats');
    insertSession(makeSession({ title: 'Task' }));
    const result = runStats({ days: '7' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Activity (last 7 days)'));
  });

  // --- Top limit ---

  test('top limit restricts number of tasks shown', () => {
    const { insertSession } = require('../models/session');
    const { runStats } = require('../commands/stats');
    for (let i = 0; i < 5; i++) {
      insertSession(makeSession({ title: `Task ${i}` }));
    }
    const result = runStats({ top: '2' });
    assert.strictEqual(result.exitCode, 0);
    const topSection = result.stdout.split('Top Tasks (by frequency)')[1];
    // Should have at most 2 numbered items
    const numberedLines = topSection.split('\n').filter((l: string) => /^\s+\d+\./.test(l));
    assert.strictEqual(numberedLines.length, 2);
  });

  // --- Number formatting ---

  test('large numbers display with comma separators', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runStats } = require('../commands/stats');
    // Create sessions with enough messages
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ title: `Task ${i}` });
      insertSession(s);
      incrementMessageCount(s.id, 1500);
    }
    const result = runStats({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('4,500'));
  });

  // --- Avg formatting ---

  test('averages display with 1 decimal place', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runStats } = require('../commands/stats');
    const s1 = makeSession({ title: 'A' });
    const s2 = makeSession({ title: 'B' });
    insertSession(s1);
    insertSession(s2);
    incrementMessageCount(s1.id, 10);
    incrementMessageCount(s2.id, 11);
    const result = runStats({});
    assert.strictEqual(result.exitCode, 0);
    // 21/2 = 10.5
    assert.ok(result.stdout.includes('10.5'));
  });

  // --- Null titles ---

  test('all sessions have null titles shows no recurring tasks message', () => {
    const { insertSession } = require('../models/session');
    const { runStats } = require('../commands/stats');
    insertSession(makeSession({ title: null as any }));
    insertSession(makeSession({ title: null as any }));
    const result = runStats({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('No recurring tasks found.'));
  });

  // --- Success paths ---

  test('success paths set exitCode 0 and stderr empty', () => {
    const { insertSession } = require('../models/session');
    const { runStats } = require('../commands/stats');
    insertSession(makeSession({ agent: 'claude-code', title: 'A session' }));
    const cases = [
      runStats({}),
      runStats({ agent: 'claude-code' }),
      runStats({ days: '7' }),
      runStats({ top: '5' }),
    ];
    for (const r of cases) {
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stderr, '');
    }
  });
});
