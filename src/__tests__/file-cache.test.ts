import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-file-cache-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('checkFileCache', () => {
  let box0Dir: string;
  let tmpDir: string;

  before(() => {
    box0Dir = makeTempDir();
    tmpDir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('returns cache miss for a file with no prior record', () => {
    const { checkFileCache } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'new-file.jsonl');
    fs.writeFileSync(filePath, 'content', 'utf8');

    const result = checkFileCache(filePath);
    assert.strictEqual(result.unchanged, false);
    assert.strictEqual(result.resolved, path.resolve(filePath));
    assert.strictEqual(typeof result.mtimeMs, 'number');
    assert.strictEqual(typeof result.sizeBytes, 'number');
  });

  test('returns cache hit when file mtime and size match recorded values', () => {
    const { checkFileCache, recordFileImported } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'cached-file.jsonl');
    fs.writeFileSync(filePath, 'hello world', 'utf8');

    const miss = checkFileCache(filePath);
    assert.strictEqual(miss.unchanged, false);
    recordFileImported(miss.resolved, miss.mtimeMs, miss.sizeBytes);

    const hit = checkFileCache(filePath);
    assert.strictEqual(hit.unchanged, true);
    assert.strictEqual(hit.resolved, path.resolve(filePath));
  });

  test('returns cache miss when mtime changes', () => {
    const { checkFileCache, recordFileImported } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'mtime-change.jsonl');
    fs.writeFileSync(filePath, 'original', 'utf8');

    const miss = checkFileCache(filePath);
    recordFileImported(miss.resolved, miss.mtimeMs, miss.sizeBytes);

    // Touch the file to change mtime without changing content
    const futureTime = Date.now() + 10000;
    fs.utimesSync(filePath, futureTime / 1000, futureTime / 1000);

    const result = checkFileCache(filePath);
    assert.strictEqual(result.unchanged, false, 'Should be cache miss after mtime change');
  });

  test('returns cache miss when size changes', () => {
    const { checkFileCache, recordFileImported } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'size-change.jsonl');
    fs.writeFileSync(filePath, 'short', 'utf8');

    const miss = checkFileCache(filePath);
    recordFileImported(miss.resolved, miss.mtimeMs, miss.sizeBytes);

    fs.appendFileSync(filePath, ' extra content appended');

    const result = checkFileCache(filePath);
    assert.strictEqual(result.unchanged, false, 'Should be cache miss after size change');
  });

  test('force=true bypasses cache even when file is unchanged', () => {
    const { checkFileCache, recordFileImported } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'force-bypass.jsonl');
    fs.writeFileSync(filePath, 'force test', 'utf8');

    const miss = checkFileCache(filePath);
    recordFileImported(miss.resolved, miss.mtimeMs, miss.sizeBytes);

    const result = checkFileCache(filePath, true);
    assert.strictEqual(result.unchanged, false, 'force=true should always return cache miss');
    assert.strictEqual(result.resolved, path.resolve(filePath));
  });

  test('resolves relative paths to absolute', () => {
    const { checkFileCache, recordFileImported } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'relative-test.jsonl');
    fs.writeFileSync(filePath, 'relative', 'utf8');

    const relPath = path.relative(process.cwd(), filePath);
    const miss = checkFileCache(relPath);
    recordFileImported(miss.resolved, miss.mtimeMs, miss.sizeBytes);

    // Query with absolute path — should still be a cache hit
    const hit = checkFileCache(filePath);
    assert.strictEqual(hit.unchanged, true, 'Absolute path should match previously recorded relative path');
  });

  test('throws when file does not exist', () => {
    const { checkFileCache } = require('../lib/file-cache');
    assert.throws(
      () => checkFileCache('/nonexistent/path/missing.jsonl'),
      (err: Error) => err.message.includes('ENOENT')
    );
  });
});

describe('recordFileImported', () => {
  let box0Dir: string;
  let tmpDir: string;

  before(() => {
    box0Dir = makeTempDir();
    tmpDir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('persists mtime and size to DB', () => {
    const { recordFileImported } = require('../lib/file-cache');
    const { getFileMeta } = require('../models/file-meta');
    const resolved = path.join(tmpDir, 'persist-test.jsonl');

    recordFileImported(resolved, 1700000000000, 4096);

    const meta = getFileMeta(resolved);
    assert.ok(meta !== undefined);
    assert.strictEqual(meta!.mtime_ms, 1700000000000);
    assert.strictEqual(meta!.size_bytes, 4096);
  });

  test('updates existing record with new values', () => {
    const { recordFileImported } = require('../lib/file-cache');
    const { getFileMeta } = require('../models/file-meta');
    const resolved = path.join(tmpDir, 'update-test.jsonl');

    recordFileImported(resolved, 1700000000000, 4096);
    recordFileImported(resolved, 1700000001000, 8192);

    const meta = getFileMeta(resolved);
    assert.ok(meta !== undefined);
    assert.strictEqual(meta!.mtime_ms, 1700000001000);
    assert.strictEqual(meta!.size_bytes, 8192);
  });

  test('round-trip: record then checkFileCache returns cache hit', () => {
    const { checkFileCache, recordFileImported } = require('../lib/file-cache');
    const filePath = path.join(tmpDir, 'round-trip.jsonl');
    fs.writeFileSync(filePath, 'round trip content', 'utf8');

    const stat = fs.statSync(filePath);
    const resolved = path.resolve(filePath);
    recordFileImported(resolved, Math.floor(stat.mtimeMs), stat.size);

    const result = checkFileCache(filePath);
    assert.strictEqual(result.unchanged, true);
  });
});
