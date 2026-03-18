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

describe('insight command (runInsight)', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-insight-cmd-test-${crypto.randomBytes(4).toString('hex')}`);
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
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ agent: 'bogus' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Unknown agent'));
    assert.ok(result.stderr.includes('claude-code'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid days (non-integer string) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ days: 'abc' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
  });

  test('invalid days (zero) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ days: '0' });
    assert.strictEqual(result.exitCode, 1);
  });

  test('invalid days (negative) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ days: '-5' });
    assert.strictEqual(result.exitCode, 1);
  });

  test('invalid days (float like 3.5) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ days: '3.5' });
    assert.strictEqual(result.exitCode, 1);
  });

  test('invalid top (non-integer) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ top: 'abc' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--top'));
  });

  test('invalid top (zero) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ top: '0' });
    assert.strictEqual(result.exitCode, 1);
  });

  test('invalid top (negative) returns exitCode 1', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ top: '-1' });
    assert.strictEqual(result.exitCode, 1);
  });

  // --- Empty DB ---

  test('empty DB shows no sessions message', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('No sessions found.'));
    assert.ok(result.stdout.includes('box0 import'));
    assert.strictEqual(result.stderr, '');
  });

  // --- Sessions outside time window ---

  test('sessions exist but outside time window shows appropriate message', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    const now = Date.now();
    insertSession(makeSession({ created_at: now - 60 * 86400000 }));
    const result = runInsight({ days: '7' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('No sessions found'));
    assert.ok(result.stdout.includes('last 7 days'));
  });

  // --- Default output with data ---

  test('default output contains all four sections', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ agent: 'claude-code', title: 'My task' });
      insertSession(s);
      incrementMessageCount(s.id, 20);
    }
    const result = runInsight({});
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    assert.ok(result.stdout.includes('=== Box0 Insight Report ==='));
    assert.ok(result.stdout.includes('Overview (last 30 days)'));
    assert.ok(result.stdout.includes('Trends'));
    assert.ok(result.stdout.includes('Top Recurring Tasks'));
    assert.ok(result.stdout.includes('Skill Suggestions'));
  });

  // --- Agent filter ---

  test('agent filter shows agent name in header and no agent distribution', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    insertSession(makeSession({ agent: 'claude-code', title: 'Task' }));
    insertSession(makeSession({ agent: 'openclaw', title: 'Task' }));
    const result = runInsight({ agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('=== Box0 Insight Report (claude-code'));
    assert.ok(!result.stdout.includes('Agents:'));
  });

  // --- Days filter ---

  test('days filter appears in header and section labels', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    insertSession(makeSession({ title: 'Task' }));
    const result = runInsight({ days: '7' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Overview (last 7 days)'));
    assert.ok(result.stdout.includes('vs previous 7 days'));
  });

  // --- Top limit ---

  test('top limit truncates both recurring tasks and skill suggestions', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) {
        insertSession(makeSession({ title: `Task ${i}` }));
      }
    }
    const result = runInsight({ top: '2' });
    assert.strictEqual(result.exitCode, 0);
    // Check top recurring tasks section
    const tasksSection = result.stdout.split('Top Recurring Tasks')[1].split('Skill Suggestions')[0];
    const taskLines = tasksSection.split('\n').filter((l: string) => /^\s+\d+\./.test(l));
    assert.ok(taskLines.length <= 2);
    // Check skill suggestions section
    const skillsSection = result.stdout.split('Skill Suggestions')[1].split('\nRun')[0];
    const skillLines = skillsSection.split('\n').filter((l: string) => /^\s+\d+\./.test(l));
    assert.ok(skillLines.length <= 2);
  });

  // --- JSON output ---

  test('JSON output is valid JSON with expected keys', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ agent: 'claude-code', title: 'My task' });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    const result = runInsight({ json: true });
    assert.strictEqual(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok('overview' in parsed);
    assert.ok('trends' in parsed);
    assert.ok('topTasks' in parsed);
    assert.ok('skillSuggestions' in parsed);
  });

  test('JSON output on empty DB returns object with zeroed/empty fields', () => {
    const { runInsight } = require('../commands/insight');
    const result = runInsight({ json: true });
    assert.strictEqual(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.overview.sessions, 0);
    assert.deepStrictEqual(parsed.topTasks, []);
    assert.deepStrictEqual(parsed.skillSuggestions, []);
  });

  // --- Trend delta formatting ---

  test('trend delta formatting: positive, negative, and null', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    const now = Date.now();
    // Previous period: 5 sessions
    for (let i = 0; i < 5; i++) {
      const s = makeSession({ title: 'Task', created_at: now - 45 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // Current period: 10 sessions (sessions +100%)
    for (let i = 0; i < 10; i++) {
      const s = makeSession({ title: 'Task', created_at: now - 5 * 86400000 });
      insertSession(s);
      incrementMessageCount(s.id, 8);
    }
    const result = runInsight({ days: '30' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('+100%'));
  });

  test('trend delta N/A when no previous period data', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    insertSession(makeSession({ title: 'Task' }));
    const result = runInsight({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('N/A'));
  });

  // --- Footer hints ---

  test('footer hints reference correct sub-commands with agent filter', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    insertSession(makeSession({ agent: 'claude-code', title: 'Task' }));
    const result = runInsight({ agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('box0 stats --agent claude-code'));
    assert.ok(result.stdout.includes('box0 suggest-skills --agent claude-code'));
  });

  test('footer hints without agent filter', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    insertSession(makeSession({ title: 'Task' }));
    const result = runInsight({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Run `box0 stats`'));
    assert.ok(result.stdout.includes('Run `box0 suggest-skills`'));
  });

  // --- Success paths ---

  test('success paths set exitCode 0 and stderr empty', () => {
    const { insertSession } = require('../models/session');
    const { runInsight } = require('../commands/insight');
    insertSession(makeSession({ agent: 'claude-code', title: 'A session' }));
    const cases = [
      runInsight({}),
      runInsight({ agent: 'claude-code' }),
      runInsight({ days: '7' }),
      runInsight({ top: '3' }),
      runInsight({ json: true }),
    ];
    for (const r of cases) {
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stderr, '');
    }
  });
});
