import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

describe('db', () => {
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

  test('getDb() creates db file', () => {
    const { getDb } = require('../lib/db');
    getDb();
    const dbFile = path.join(tempDir, 'box0.db');
    assert.ok(fs.existsSync(dbFile), 'box0.db should exist');
  });

  test('tables exist after init', () => {
    const { getDb } = require('../lib/db');
    const db = getDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions','messages','messages_fts')`)
      .all()
      .map((r: any) => r.name);
    assert.ok(tables.includes('sessions'), 'sessions table should exist');
    assert.ok(tables.includes('messages'), 'messages table should exist');
    assert.ok(tables.includes('messages_fts'), 'messages_fts table should exist');
  });

  test('getDb() is idempotent (same instance)', () => {
    const { getDb } = require('../lib/db');
    const a = getDb();
    const b = getDb();
    assert.strictEqual(a, b);
  });

  test('PRAGMA foreign_keys = ON', () => {
    const { getDb } = require('../lib/db');
    const db = getDb();
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.strictEqual(row.foreign_keys, 1);
  });

  test('PRAGMA journal_mode = WAL', () => {
    const { getDb } = require('../lib/db');
    const db = getDb();
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.strictEqual(row.journal_mode, 'wal');
  });
});
