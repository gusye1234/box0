import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session } from '../types';

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

describe('session model', () => {
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

  test('insertSession + findById', () => {
    const { insertSession, findById } = require('../models/session');
    const s = makeSession();
    const { inserted } = insertSession(s);
    assert.ok(inserted);
    const found = findById(s.id);
    assert.ok(found);
    assert.strictEqual(found.id, s.id);
    assert.strictEqual(found.agent, s.agent);
  });

  test('dedup: existsBySourcePath returns false then true', () => {
    const { insertSession, existsBySourcePath } = require('../models/session');
    const s = makeSession({ source_path: '/tmp/unique-test.jsonl' });
    assert.strictEqual(existsBySourcePath(s.source_path), false);
    insertSession(s);
    assert.strictEqual(existsBySourcePath(s.source_path), true);
  });

  test('insertSession OR IGNORE returns inserted:false on duplicate', () => {
    const { insertSession } = require('../models/session');
    const s = makeSession();
    insertSession(s);
    const { inserted } = insertSession(s);
    assert.strictEqual(inserted, false);
  });

  test('findByAgent returns only matching agent', () => {
    const { insertSession, findByAgent } = require('../models/session');
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'openclaw' }));
    const results = findByAgent('claude-code');
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r: Session) => r.agent === 'claude-code'));
  });

  test('listAll ordering by created_at DESC', () => {
    const { insertSession, listAll } = require('../models/session');
    const now = Date.now();
    // updated_at is intentionally in reverse order to disambiguate from created_at sort
    insertSession(makeSession({ created_at: now - 10000, updated_at: now }));
    insertSession(makeSession({ created_at: now - 5000, updated_at: now - 8000 }));
    insertSession(makeSession({ created_at: now, updated_at: now - 3000 }));
    const results = listAll(100, 'created');
    assert.ok(results[0].created_at >= results[1].created_at);
    assert.ok(results[1].created_at >= results[2].created_at);
  });

  test('listAll ordering by updated_at DESC', () => {
    const { insertSession, listAll } = require('../models/session');
    const now = Date.now();
    // created_at is in reverse order relative to updated_at
    const sA = makeSession({ created_at: now, updated_at: now - 10000 });
    const sB = makeSession({ created_at: now - 5000, updated_at: now - 5000 });
    const sC = makeSession({ created_at: now - 10000, updated_at: now });
    insertSession(sA);
    insertSession(sB);
    insertSession(sC);
    const results = listAll(100, 'updated');
    // Expected order: C, B, A (by updated_at DESC)
    assert.strictEqual(results[0].id, sC.id);
    assert.strictEqual(results[1].id, sB.id);
    assert.strictEqual(results[2].id, sA.id);
  });

  test('countByAgent returns correct count per agent', () => {
    const { insertSession, countByAgent } = require('../models/session');
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'claude-code' }));
    insertSession(makeSession({ agent: 'openclaw' }));
    assert.strictEqual(countByAgent('claude-code'), 2);
    assert.strictEqual(countByAgent('openclaw'), 1);
  });

  test('count returns correct number', () => {
    const { insertSession, count } = require('../models/session');
    assert.strictEqual(count(), 0);
    insertSession(makeSession());
    insertSession(makeSession());
    assert.strictEqual(count(), 2);
  });

  test('incrementMessageCount updates correctly', () => {
    const { insertSession, incrementMessageCount, findById } = require('../models/session');
    const s = makeSession();
    insertSession(s);
    incrementMessageCount(s.id, 5);
    const found = findById(s.id);
    assert.strictEqual(found.message_count, 5);
    incrementMessageCount(s.id, 3);
    const found2 = findById(s.id);
    assert.strictEqual(found2.message_count, 8);
  });
});
