import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session } from '../types';

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

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

describe('suggest-skills command (runSuggestSkills)', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-suggest-skills-cmd-test-${crypto.randomBytes(4).toString('hex')}`);
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
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ agent: 'bogus' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Unknown agent'));
    assert.ok(result.stderr.includes('claude-code'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid days (non-integer string) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ days: 'abc' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid days (zero) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ days: '0' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
  });

  test('invalid days (negative) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ days: '-5' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--days'));
  });

  test('invalid top (non-integer) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ top: '2.5' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--top'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid top (zero) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ top: '0' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--top'));
  });

  test('invalid top (negative) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ top: '-1' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--top'));
  });

  test('invalid min-freq (non-integer) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ minFreq: '1.5' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--min-freq'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid min-freq (zero) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ minFreq: '0' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--min-freq'));
  });

  test('invalid min-freq (negative) returns exitCode 1', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ minFreq: '-2' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--min-freq'));
  });

  // --- Empty DB ---

  test('empty DB output contains "No workflow patterns found"', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('No workflow patterns found'));
    assert.strictEqual(result.stderr, '');
  });

  // --- Default output with data ---

  test('default output with data shows numbered list with pattern and suggestion', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runSuggestSkills } = require('../commands/suggest-skills');
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ title: 'Fix login flow' });
      insertSession(s);
      incrementMessageCount(s.id, 42);
    }
    const result = runSuggestSkills({});
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const plain = stripAnsi(result.stdout);
    assert.ok(plain.includes('=== Skill Suggestions ==='));
    assert.ok(plain.includes('Found 1 workflow pattern'));
    assert.ok(plain.includes('1.'));
    assert.ok(plain.includes('"Fix login flow"'));
    assert.ok(plain.includes('Frequency:'));
    assert.ok(plain.includes('Agent:'));
    assert.ok(plain.includes('Avg msgs:'));
    assert.ok(plain.includes('Pattern:'));
    assert.ok(plain.includes('Suggestion:'));
  });

  // --- Agent filter ---

  test('agent filter shows agent name in header', () => {
    const { insertSession } = require('../models/session');
    const { runSuggestSkills } = require('../commands/suggest-skills');
    insertSession(makeSession({ title: 'Task', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Task', agent: 'claude-code' }));
    const result = runSuggestSkills({ agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(stripAnsi(result.stdout).includes('=== Skill Suggestions (claude-code'));
  });

  // --- JSON output ---

  test('JSON output is valid JSON array with correct fields', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { runSuggestSkills } = require('../commands/suggest-skills');
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Fix bug' });
      insertSession(s);
      incrementMessageCount(s.id, 20);
    }
    const result = runSuggestSkills({ json: true });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.ok('title' in parsed[0]);
    assert.ok('frequency' in parsed[0]);
    assert.ok('agents' in parsed[0]);
    assert.ok('avgMessages' in parsed[0]);
    assert.ok('pattern' in parsed[0]);
    assert.ok('suggestion' in parsed[0]);
  });

  test('JSON output on empty DB returns []', () => {
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const result = runSuggestSkills({ json: true });
    assert.strictEqual(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, []);
  });

  // --- Min-freq filter ---

  test('min-freq filter excludes tasks below threshold', () => {
    const { insertSession } = require('../models/session');
    const { runSuggestSkills } = require('../commands/suggest-skills');
    // 2 sessions for Task A
    insertSession(makeSession({ title: 'Task A' }));
    insertSession(makeSession({ title: 'Task A' }));
    // 1 session for Task B (below default minFreq=2)
    insertSession(makeSession({ title: 'Task B' }));
    const result = runSuggestSkills({ json: true });
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].title, 'Task A');
  });

  // --- Days filter affects results ---

  test('days filter affects results', () => {
    const { insertSession } = require('../models/session');
    const { runSuggestSkills } = require('../commands/suggest-skills');
    const now = Date.now();
    insertSession(makeSession({ title: 'Old task', created_at: now - 60 * 86400000 }));
    insertSession(makeSession({ title: 'Old task', created_at: now - 61 * 86400000 }));
    const result = runSuggestSkills({ json: true, days: '7' });
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, []);
  });

  // --- Success paths ---

  test('success paths set exitCode 0 and stderr empty', () => {
    const { insertSession } = require('../models/session');
    const { runSuggestSkills } = require('../commands/suggest-skills');
    insertSession(makeSession({ title: 'Task', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Task', agent: 'claude-code' }));
    const cases = [
      runSuggestSkills({}),
      runSuggestSkills({ agent: 'claude-code' }),
      runSuggestSkills({ days: '7' }),
      runSuggestSkills({ top: '5' }),
      runSuggestSkills({ minFreq: '1' }),
      runSuggestSkills({ json: true }),
    ];
    for (const r of cases) {
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stderr, '');
    }
  });
});
