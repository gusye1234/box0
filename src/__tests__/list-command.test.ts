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

describe('list command (runList)', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-list-test-${crypto.randomBytes(4).toString('hex')}`);
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

  test('empty database returns no sessions message', () => {
    const { runList } = require('../commands/list');
    const result = runList({});
    assert.ok(result.stdout.includes('No sessions found.'));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
  });

  test('default list returns all sessions sorted by updated_at DESC', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    const now = Date.now();
    const sA = makeSession({ agent: 'claude-code', title: 'Session A', updated_at: now - 10000, created_at: now });
    const sB = makeSession({ agent: 'openclaw', title: 'Session B', updated_at: now - 5000, created_at: now - 5000 });
    const sC = makeSession({ agent: 'codex', title: 'Session C', updated_at: now, created_at: now - 10000 });
    insertSession(sA);
    insertSession(sB);
    insertSession(sC);
    const result = runList({});
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const lines = result.stdout.split('\n').filter((l: string) => l.trim() !== '');
    // Header + 3 rows
    assert.ok(lines.length >= 4);
    // sC has highest updated_at so should appear first
    assert.ok(lines[1].includes(sC.id.slice(0, 8)));
    assert.ok(lines[2].includes(sB.id.slice(0, 8)));
    assert.ok(lines[3].includes(sA.id.slice(0, 8)));
  });

  test('agent filter returns only matching sessions', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    insertSession(makeSession({ agent: 'claude-code', title: 'Claude session 1' }));
    insertSession(makeSession({ agent: 'claude-code', title: 'Claude session 2' }));
    insertSession(makeSession({ agent: 'openclaw', title: 'OpenClaw session' }));
    const result = runList({ agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    assert.ok(result.stdout.includes('claude-code'));
    assert.ok(!result.stdout.includes('openclaw'));
    // Should show 2 claude-code rows
    const rows = result.stdout.split('\n').filter((l: string) => l.includes('msgs'));
    assert.strictEqual(rows.length, 2);
  });

  test('invalid agent returns exitCode 1', () => {
    const { runList } = require('../commands/list');
    const result = runList({ agent: 'bogus' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Unknown agent'));
    assert.strictEqual(result.stdout, '');
  });

  test('limit restricts number of rows', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    for (let i = 0; i < 5; i++) {
      insertSession(makeSession({ title: `Session ${i}` }));
    }
    const result = runList({ limit: '2' });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const rows = result.stdout.split('\n').filter((l: string) => l.includes('msgs'));
    assert.strictEqual(rows.length, 2);
  });

  test('invalid limit (non-integer) returns exitCode 1', () => {
    const { runList } = require('../commands/list');
    const result = runList({ limit: 'abc' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--limit'));
    assert.strictEqual(result.stdout, '');
  });

  test('invalid limit (zero) returns exitCode 1', () => {
    const { runList } = require('../commands/list');
    const result = runList({ limit: '0' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--limit'));
    assert.strictEqual(result.stdout, '');
  });

  test('negative limit returns exitCode 1', () => {
    const { runList } = require('../commands/list');
    const result = runList({ limit: '-1' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--limit'));
    assert.strictEqual(result.stdout, '');
  });

  test('limit as number (not string) returns rows without error', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    for (let i = 0; i < 5; i++) {
      insertSession(makeSession({ title: `Session ${i}` }));
    }
    const result = runList({ limit: 2 });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const rows = result.stdout.split('\n').filter((l: string) => l.includes('msgs'));
    assert.strictEqual(rows.length, 2);
  });

  test('sort by created orders by created_at DESC', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    const now = Date.now();
    const sA = makeSession({ created_at: now - 10000, updated_at: now });       // created earliest, updated latest
    const sB = makeSession({ created_at: now, updated_at: now - 10000 });       // created latest, updated earliest
    insertSession(sA);
    insertSession(sB);
    const result = runList({ sort: 'created' });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const rows = result.stdout.split('\n').filter((l: string) => l.includes('msgs'));
    // sB has the highest created_at so comes first
    assert.ok(rows[0].includes(sB.id.slice(0, 8)));
    assert.ok(rows[1].includes(sA.id.slice(0, 8)));
  });

  test('sort by updated (default) orders by updated_at DESC', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    const now = Date.now();
    const sA = makeSession({ created_at: now - 10000, updated_at: now });       // updated latest
    const sB = makeSession({ created_at: now, updated_at: now - 10000 });       // updated earliest
    insertSession(sA);
    insertSession(sB);
    const result = runList({});
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, '');
    const rows = result.stdout.split('\n').filter((l: string) => l.includes('msgs'));
    // sA has the highest updated_at so comes first
    assert.ok(rows[0].includes(sA.id.slice(0, 8)));
    assert.ok(rows[1].includes(sB.id.slice(0, 8)));
  });

  test('invalid sort returns exitCode 1', () => {
    const { runList } = require('../commands/list');
    const result = runList({ sort: 'bogus' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--sort'));
    assert.strictEqual(result.stdout, '');
  });

  test('null title displays as (untitled)', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    insertSession(makeSession({ title: null as any }));
    const result = runList({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('(untitled)'));
  });

  test('header line contains total, limit, and sort', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'claude-code' }));
    const result = runList({ agent: 'claude-code', sort: 'created' });
    assert.strictEqual(result.exitCode, 0);
    const header = result.stdout.split('\n')[0];
    assert.ok(header.includes('2 total'));
    assert.ok(header.includes('agent: claude-code'));
    assert.ok(header.includes('sorted by: created'));
  });

  test('ID prefix shows first 8 chars followed by ellipsis', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    const s = makeSession({ id: 'abcdef1234567890' });
    insertSession(s);
    const result = runList({});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('abcdef12…'));
  });

  test('agent + limit where total > limit shows true total in header', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    for (let i = 0; i < 5; i++) {
      insertSession(makeSession({ agent: 'claude-code', title: `Session ${i}` }));
    }
    const result = runList({ agent: 'claude-code', limit: '2' });
    assert.strictEqual(result.exitCode, 0);
    const header = result.stdout.split('\n')[0];
    assert.ok(header.includes('5 total'));
    assert.ok(header.includes('showing 2'));
  });

  test('date column reflects sort field (created shows created_at year)', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    const created2020 = new Date('2020-06-15T00:00:00Z').getTime();
    const updated2026 = new Date('2026-03-17T00:00:00Z').getTime();
    insertSession(makeSession({ created_at: created2020, updated_at: updated2026 }));
    const resultCreated = runList({ sort: 'created' });
    assert.ok(resultCreated.stdout.includes('2020-'));
    assert.ok(!resultCreated.stdout.split('\n').some((l: string) => l.includes('msgs') && l.includes('2026-')));
  });

  test('title truncation at 40 chars', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    const longTitle = 'A'.repeat(50);
    insertSession(makeSession({ title: longTitle }));
    const result = runList({});
    assert.strictEqual(result.exitCode, 0);
    // The output should contain exactly 40 A's (truncated), not 50
    assert.ok(result.stdout.includes('A'.repeat(40)));
    assert.ok(!result.stdout.includes('A'.repeat(41)));
  });

  test('unfiltered total > limit shows true total in header', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    for (let i = 0; i < 5; i++) {
      insertSession(makeSession({ title: `Session ${i}` }));
    }
    const result = runList({ limit: '3' });
    assert.strictEqual(result.exitCode, 0);
    const header = result.stdout.split('\n')[0];
    assert.ok(header.includes('5 total'));
    assert.ok(header.includes('showing 3'));
  });

  test('all valid-input paths set exitCode 0 and stderr empty', () => {
    const { insertSession } = require('../models/session');
    const { runList } = require('../commands/list');
    insertSession(makeSession({ agent: 'openclaw', title: 'A session' }));
    const cases = [
      runList({}),
      runList({ agent: 'openclaw' }),
      runList({ limit: '5' }),
      runList({ sort: 'created' }),
      runList({ sort: 'updated' }),
    ];
    for (const r of cases) {
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stderr, '');
    }
  });
});
