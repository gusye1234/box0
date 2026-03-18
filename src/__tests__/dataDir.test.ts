import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureDataDir } from '../lib/dataDir';

function withTempDir(fn: (dir: string) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'box0-test-'));
  const orig = process.env.BOX0_DIR;
  process.env.BOX0_DIR = tmpDir;
  try {
    fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (orig === undefined) delete process.env.BOX0_DIR;
    else process.env.BOX0_DIR = orig;
  }
}

test('ensureDataDir creates ~/.box0/, data/, and logs/ when they do not exist', () => {
  withTempDir((dir) => {
    ensureDataDir();
    assert.ok(fs.existsSync(dir), 'base dir exists');
    assert.ok(fs.existsSync(path.join(dir, 'data')), 'data/ exists');
    assert.ok(fs.existsSync(path.join(dir, 'logs')), 'logs/ exists');
  });
});

test('ensureDataDir is idempotent — calling twice does not throw', () => {
  withTempDir(() => {
    assert.doesNotThrow(() => {
      ensureDataDir();
      ensureDataDir();
    });
  });
});
