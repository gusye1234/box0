import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session, Message } from '../types';

function makeSession(overrides: Partial<Omit<Session, 'message_count'>> = {}): Omit<Session, 'message_count'> {
  return {
    id: crypto.randomBytes(10).toString('hex'),
    agent: 'claude-code',
    title: 'Test session',
    source_path: `/tmp/test-${crypto.randomBytes(4).toString('hex')}.jsonl`,
    created_at: Date.now(),
    updated_at: Date.now(),
    imported_at: Date.now(),
    ...overrides,
  };
}

function makeMessages(sessionId: string, contents: string[]): Message[] {
  return contents.map((content, seq) => ({
    id: `${sessionId}:${seq}`,
    session_id: sessionId,
    role: 'user' as const,
    content,
    seq,
    timestamp: null,
  }));
}

describe('message model', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-test-${crypto.randomBytes(4).toString('hex')}`);
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

  test('insertBatch + findBySession returns in seq order', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, findBySession } = require('../models/message');
    const s = makeSession();
    insertSession(s);
    const msgs = makeMessages(s.id, ['first', 'second', 'third']);
    insertBatch(msgs);
    const found = findBySession(s.id);
    assert.strictEqual(found.length, 3);
    assert.strictEqual(found[0].content, 'first');
    assert.strictEqual(found[2].content, 'third');
  });

  test('idempotent batch: duplicate insertBatch does not error', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, findBySession } = require('../models/message');
    const s = makeSession();
    insertSession(s);
    const msgs = makeMessages(s.id, ['hello']);
    insertBatch(msgs);
    insertBatch(msgs); // second call should be a no-op
    const found = findBySession(s.id);
    assert.strictEqual(found.length, 1);
  });

  test('insertBatch updates session message_count', () => {
    const { insertSession, findById } = require('../models/session');
    const { insertBatch } = require('../models/message');
    const s = makeSession();
    insertSession(s);
    insertBatch(makeMessages(s.id, ['a', 'b', 'c']));
    const found = findById(s.id);
    assert.strictEqual(found.message_count, 3);
  });

  test('FTS search basic: finds message by keyword', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, search } = require('../models/message');
    const s = makeSession();
    insertSession(s);
    insertBatch(makeMessages(s.id, ['TypeScript is great for large projects']));
    const results = search('typescript');
    assert.ok(results.length > 0, 'should find at least one result');
    assert.strictEqual(results[0].session_id, s.id);
  });

  test('FTS search agent filter: only returns matching agent', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, search } = require('../models/message');
    const s1 = makeSession({ agent: 'claude-code' });
    const s2 = makeSession({ agent: 'openclaw' });
    insertSession(s1);
    insertSession(s2);
    insertBatch(makeMessages(s1.id, ['typescript is awesome']));
    insertBatch(makeMessages(s2.id, ['typescript rocks too']));

    const results = search('typescript', 'claude-code');
    assert.ok(results.length > 0);
    assert.ok(results.every((r: any) => r.agent === 'claude-code'));
  });

  test('FTS search snippet contains highlight tags', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, search } = require('../models/message');
    const s = makeSession();
    insertSession(s);
    insertBatch(makeMessages(s.id, ['learning typescript with box0 project']));
    const results = search('typescript');
    assert.ok(results.length > 0);
    assert.ok(results[0].snippet.includes('<b>'), 'snippet should include <b> tag');
  });

  test('insertBatch rolls back entirely on mid-batch error', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, findBySession } = require('../models/message');
    const s = makeSession();
    insertSession(s);
    // Second message references a non-existent session_id; ON CONFLICT does not suppress FK errors
    const msgs: Message[] = [
      { id: `${s.id}:0`, session_id: s.id, role: 'user', content: 'ok', seq: 0, timestamp: null },
      { id: 'bad:0', session_id: 'nonexistent-session-id', role: 'user', content: 'fail', seq: 0, timestamp: null },
    ];
    assert.throws(() => insertBatch(msgs), 'should throw on FK violation');
    assert.strictEqual(findBySession(s.id).length, 0, 'transaction should have rolled back');
  });

  test('CASCADE delete: deleting session removes messages', () => {
    const { insertSession } = require('../models/session');
    const { insertBatch, findBySession } = require('../models/message');
    const { getDb } = require('../lib/db');
    const s = makeSession();
    insertSession(s);
    insertBatch(makeMessages(s.id, ['msg1', 'msg2']));
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    const found = findBySession(s.id);
    assert.strictEqual(found.length, 0);
  });
});
