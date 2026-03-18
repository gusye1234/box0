import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session, Message } from '../types';

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

function makeMessage(sessionId: string, content: string, seq = 0): Message {
  return {
    id: `${sessionId}:${seq}`,
    session_id: sessionId,
    role: 'user',
    content,
    seq,
    timestamp: null,
  };
}

describe('search command (runSearch)', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-search-test-${crypto.randomBytes(4).toString('hex')}`);
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

  test('basic search returns results with title, date, snippet, session id', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s = makeSession({ title: 'Auth Fix', created_at: new Date('2026-03-15').getTime() });
    insertSession(s);
    insertBatch([makeMessage(s.id, 'fixed the authentication bug in the middleware')]);

    const result = runSearch('authentication', {});
    assert.strictEqual(result.exitCode, 0);
    const plain = stripAnsi(result.stdout);
    assert.ok(plain.includes('Auth Fix'), 'Should include session title');
    assert.ok(plain.includes('2026-03-1'), 'Should include date');
    assert.ok(plain.includes('authentication'), 'Should include keyword');
    assert.ok(plain.includes(`session: ${s.id}`), 'Should include session id');
    assert.ok(!plain.includes('<b>'), 'Should not include raw <b> tags');
  });

  test('--agent filter narrows results', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s1 = makeSession({ agent: 'claude-code' });
    const s2 = makeSession({ agent: 'openclaw' });
    insertSession(s1);
    insertSession(s2);
    insertBatch([makeMessage(s1.id, 'refactor the database layer for claude')]);
    insertBatch([makeMessage(s2.id, 'refactor the api layer for openclaw')]);

    const result = runSearch('refactor', { agent: 'claude-code' });
    assert.strictEqual(result.exitCode, 0);
    const plain = stripAnsi(result.stdout);
    assert.ok(plain.includes('[claude-code]'), 'Should include claude-code result');
    assert.ok(!plain.includes('[openclaw]'), 'Should not include openclaw result');
    assert.ok(plain.includes('(agent: claude-code)'), 'Should note agent filter in header');
  });

  test('invalid agent prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('foo', { agent: 'badagent' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Unknown agent "badagent"'), 'Should mention bad agent name');
    assert.ok(result.stderr.includes('claude-code'), 'Should list valid agents');
  });

  test('--limit caps number of results', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s = makeSession();
    insertSession(s);
    const msgs: Message[] = Array.from({ length: 5 }, (_, i) =>
      makeMessage(s.id, `typescript project number ${i}`, i)
    );
    insertBatch(msgs);

    const result = runSearch('typescript', { limit: '2' });
    assert.strictEqual(result.exitCode, 0);
    const plain = stripAnsi(result.stdout);
    const matches = plain.match(/session: /g);
    assert.ok(matches !== null && matches.length <= 2, 'Should return at most 2 results');
  });

  test('--limit with non-integer prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('foo', { limit: 'abc' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--limit must be a positive integer'));
  });

  test('--limit with zero prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('foo', { limit: '0' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--limit must be a positive integer'));
  });

  test('--limit with negative value prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('foo', { limit: '-1' });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('--limit must be a positive integer'));
  });

  test('no results prints friendly message', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('xyzzy_no_match_ever', {});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('No results found for "xyzzy_no_match_ever"'));
  });

  test('empty query string prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('', {});
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Query must not be empty'));
  });

  test('whitespace-only query string prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('   ', {});
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('Query must not be empty'));
  });

  test('snippet <b> tags are rendered as bold, not printed literally', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s = makeSession();
    insertSession(s);
    insertBatch([makeMessage(s.id, 'typescript is the best programming language for large scale apps')]);

    const result = runSearch('typescript', {});
    assert.strictEqual(result.exitCode, 0);
    const plain = stripAnsi(result.stdout);
    assert.ok(!plain.includes('<b>'), 'Should not contain raw <b> tags');
    assert.ok(plain.toLowerCase().includes('typescript'), 'Keyword should still be visible');
  });

  test('null session title is displayed as (untitled)', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s = makeSession({ title: null });
    insertSession(s);
    insertBatch([makeMessage(s.id, 'untitled session content for searching')]);

    const result = runSearch('untitled', {});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(stripAnsi(result.stdout).includes('(untitled)'), 'Should show (untitled) for null title');
  });

  test('session ID (full 40-char hex) appears in output', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s = makeSession();
    insertSession(s);
    insertBatch([makeMessage(s.id, 'session id verification test content')]);

    const result = runSearch('verification', {});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(stripAnsi(result.stdout).includes(`session: ${s.id}`), 'Should show full session id');
  });

  test('session missing from DB is silently skipped', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { getDb } = require('../lib/db');
    const { runSearch } = require('../commands/search');

    const s = makeSession();
    insertSession(s);
    insertBatch([makeMessage(s.id, 'phantom session content for testing')]);
    // Delete the session so findById returns undefined
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(s.id);

    const result = runSearch('phantom', {});
    assert.strictEqual(result.exitCode, 0);
    // Should show no results since the session is gone
    assert.ok(result.stdout.includes('No results found'), 'Should skip result without crashing');
  });

  test('malformed FTS5 query prints error and exits 1', () => {
    const { runSearch } = require('../commands/search');
    const result = runSearch('"unclosed', {});
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderr.includes('invalid FTS5 query syntax'), 'Should mention FTS5 syntax');
    assert.ok(result.stderr.includes('Tip:'), 'Should include tip');
  });

  test('FTS5 phrase search works end-to-end', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const { runSearch } = require('../commands/search');

    const s = makeSession();
    insertSession(s);
    insertBatch([makeMessage(s.id, 'exact phrase here in this message content')]);

    const result = runSearch('"exact phrase"', {});
    assert.strictEqual(result.exitCode, 0);
    assert.ok(stripAnsi(result.stdout).includes(`session: ${s.id}`), 'Should find the message with exact phrase');
  });
});
