import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

function makeTempDir(label: string): string {
  const dir = path.join(os.tmpdir(), `box0-e2e-cx-${label}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getNodePath(): string {
  return process.execPath;
}

function getBox0Entry(): string {
  const binPath = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
  if (!fs.existsSync(binPath)) {
    throw new Error(`box0 binary not found at ${binPath} — run npm run build first`);
  }
  return binPath;
}

function runBox0(box0Dir: string, args: string[]): string {
  return execFileSync(getNodePath(), [getBox0Entry(), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, BOX0_DIR: box0Dir },
  });
}

function writeJSONL(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function appendJSONL(filePath: string, lines: object[]): void {
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function makeThreadStarted(sessionId?: string) {
  return { type: 'thread.started', session_id: sessionId ?? crypto.randomUUID(), timestamp: '2026-03-01T10:00:00.000Z' };
}

function makeTurnItem(role: 'user' | 'assistant', text: string, timestamp?: string) {
  const item: Record<string, unknown> = { role, content: text };
  if (timestamp) item.timestamp = timestamp;
  return item;
}

describe('e2e: Codex plugin full pipeline (batch import)', () => {
  let box0Dir: string;
  let codexDir: string;
  let rolloutPath: string;
  let origBox0Dir: string | undefined;

  before(() => {
    origBox0Dir = process.env.BOX0_DIR;
    box0Dir = makeTempDir('box0dir');
    codexDir = makeTempDir('codex-sessions');
    process.env.BOX0_DIR = box0Dir;

    rolloutPath = path.join(codexDir, 'rollout-e2e-test.jsonl');
  });

  after(() => {
    try {
      const { closeDb } = require('../lib/db');
      closeDb();
    } catch { /* ignore */ }

    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });

    if (origBox0Dir !== undefined) {
      process.env.BOX0_DIR = origBox0Dir;
    } else {
      delete process.env.BOX0_DIR;
    }
  });

  test('first batch import: session + messages in SQLite', () => {
    writeJSONL(rolloutPath, [
      makeThreadStarted('e2e-codex-session'),
      makeTurnItem('user', 'Explain async/await', '2026-03-01T10:01:00.000Z'),
      makeTurnItem('assistant', 'async/await is syntactic sugar for Promises.', '2026-03-01T10:01:05.000Z'),
    ]);

    runBox0(box0Dir, ['import', 'codex', '--path', codexDir]);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ agent: string; title: string; message_count: number; source_path: string }>;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].agent, 'codex');
    assert.ok(sessions[0].title!.includes('async/await'));
    assert.strictEqual(sessions[0].source_path, rolloutPath);

    const messages = db.prepare('SELECT * FROM messages ORDER BY seq ASC').all() as Array<{ role: string; content: string }>;
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content, 'Explain async/await');
    assert.strictEqual(messages[1].role, 'assistant');
    assert.ok(messages[1].content.includes('syntactic sugar'));
  });

  test('incremental import: appended messages → only new ones inserted', () => {
    appendJSONL(rolloutPath, [
      makeTurnItem('user', 'What about error handling?', '2026-03-01T10:02:00.000Z'),
      makeTurnItem('assistant', 'Use try/catch with async/await.', '2026-03-01T10:02:05.000Z'),
    ]);

    runBox0(box0Dir, ['import', 'codex', '--path', codexDir]);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ message_count: number }>;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].message_count, 4);

    const messages = db.prepare('SELECT * FROM messages ORDER BY seq ASC').all() as Array<{ role: string; content: string }>;
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[2].role, 'user');
    assert.ok(messages[2].content.includes('error handling'));
    assert.strictEqual(messages[3].role, 'assistant');
    assert.ok(messages[3].content.includes('try/catch'));
  });

  test('idempotent import: re-import unchanged → no duplicates', () => {
    runBox0(box0Dir, ['import', 'codex', '--path', codexDir]);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ message_count: number }>;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].message_count, 4);

    const msgCount = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.strictEqual(msgCount, 4);
  });
});
