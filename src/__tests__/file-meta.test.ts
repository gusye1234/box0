import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-file-meta-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('file-meta model', () => {
  let box0Dir: string;

  before(() => {
    box0Dir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('getFileMeta returns undefined for unknown path', () => {
    const { getFileMeta } = require('../models/file-meta');
    assert.strictEqual(getFileMeta('/nonexistent/path/file.jsonl'), undefined);
  });

  test('upsertFileMeta inserts and then getFileMeta returns correct values', () => {
    const { getFileMeta, upsertFileMeta } = require('../models/file-meta');
    const filePath = '/tmp/test-file.jsonl';
    upsertFileMeta(filePath, 1700000000000, 4096);
    const result = getFileMeta(filePath);
    assert.ok(result !== undefined);
    assert.strictEqual(result!.mtime_ms, 1700000000000);
    assert.strictEqual(result!.size_bytes, 4096);
  });

  test('upsertFileMeta updates existing entry when called with new values', () => {
    const { getFileMeta, upsertFileMeta } = require('../models/file-meta');
    const filePath = '/tmp/update-test.jsonl';
    upsertFileMeta(filePath, 1700000000000, 4096);
    upsertFileMeta(filePath, 1700000001000, 8192);
    const result = getFileMeta(filePath);
    assert.ok(result !== undefined);
    assert.strictEqual(result!.mtime_ms, 1700000001000);
    assert.strictEqual(result!.size_bytes, 8192);
  });

  test('paths are normalized (relative and absolute paths for same file produce same key)', () => {
    const { getFileMeta, upsertFileMeta } = require('../models/file-meta');
    const tmpDir = makeTempDir();
    const absPath = path.join(tmpDir, 'norm-test.jsonl');
    fs.writeFileSync(absPath, 'test', 'utf8');

    upsertFileMeta(absPath, 1700000000000, 4);
    const cwd = process.cwd();
    const relPath = path.relative(cwd, absPath);
    const result = getFileMeta(relPath);
    assert.ok(result !== undefined, `Expected file meta for relative path "${relPath}" to resolve to same entry as "${absPath}"`);
    assert.strictEqual(result!.mtime_ms, 1700000000000);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('DB migration', () => {
  let box0Dir: string;

  before(() => {
    box0Dir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('new DB has file_meta table and user_version = 2', () => {
    const { getDb } = require('../lib/db');
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_meta'").all();
    assert.strictEqual(tables.length, 1);
    const version = Number(db.pragma('user_version', { simple: true }));
    assert.strictEqual(version, 2);
  });

  test('resetDb() clears file_meta (DB file is deleted and recreated)', () => {
    const { getDb, resetDb } = require('../lib/db');
    const { upsertFileMeta, getFileMeta } = require('../models/file-meta');
    upsertFileMeta('/tmp/reset-test.jsonl', 1700000000000, 100);
    assert.ok(getFileMeta('/tmp/reset-test.jsonl') !== undefined);
    resetDb();
    assert.strictEqual(getFileMeta('/tmp/reset-test.jsonl'), undefined);
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_meta'").all();
    assert.strictEqual(tables.length, 1);
  });
});
