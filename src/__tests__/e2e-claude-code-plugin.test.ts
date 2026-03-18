import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';

// ─── Prerequisites ───────────────────────────────────────────────────────────

function hasBash(): boolean {
  try { execSync('command -v bash', { stdio: 'pipe' }); return true; } catch { return false; }
}
function hasJq(): boolean {
  try { execSync('command -v jq', { stdio: 'pipe' }); return true; } catch { return false; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(label: string): string {
  const dir = path.join(os.tmpdir(), `box0-e2e-${label}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEntry(role: 'user' | 'assistant', content: string, timestamp: string) {
  return {
    type: role,
    uuid: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    timestamp,
    message: { role, content },
  };
}

function writeJSONL(filePath: string, entries: object[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function appendJSONL(filePath: string, entries: object[]): void {
  fs.appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function fireStopHook(scriptPath: string, transcriptPath: string, opts?: { stopHookActive?: boolean }): string {
  const stdin = JSON.stringify({
    session_id: 'test-session',
    transcript_path: transcriptPath,
    cwd: path.dirname(transcriptPath),
    stop_hook_active: opts?.stopHookActive ?? false,
    hook_event_name: 'Stop',
  });
  return execSync(`bash "${scriptPath}"`, {
    encoding: 'utf8',
    input: stdin,
    timeout: 15_000,
  });
}

// Resolve the project's own box0 binary (dist/index.js)
function getBox0BinPath(): string {
  const binPath = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
  if (!fs.existsSync(binPath)) {
    throw new Error(`box0 binary not found at ${binPath} — run npm run build first`);
  }
  return binPath;
}

function getNodePath(): string {
  return process.execPath;
}

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('e2e: Claude Code plugin full pipeline', { skip: !hasBash() || !hasJq() }, () => {
  let box0Dir: string;
  let transcriptDir: string;
  let hookScriptPath: string;
  let transcriptPath: string;
  let origBox0Dir: string | undefined;

  before(() => {
    origBox0Dir = process.env.BOX0_DIR;

    box0Dir = makeTempDir('box0dir');
    transcriptDir = makeTempDir('transcripts');
    transcriptPath = path.join(transcriptDir, 'session-abc123.jsonl');

    process.env.BOX0_DIR = box0Dir;

    // Build the hook script pointing to the project's own box0 binary.
    // We wrap it with `node <dist/index.js>` so it works without npm link.
    const nodePath = getNodePath();
    const box0Entry = getBox0BinPath();
    const box0Wrapper = path.join(box0Dir, 'box0-wrapper.sh');
    fs.mkdirSync(path.dirname(box0Wrapper), { recursive: true });
    fs.writeFileSync(box0Wrapper, `#!/bin/bash\nexec "${nodePath}" "${box0Entry}" "$@"\n`, { mode: 0o755 });

    const { buildHookScript } = require('../lib/plugin-claude-code');
    hookScriptPath = path.join(box0Dir, 'hooks', 'box0-claude-sync.sh');
    fs.mkdirSync(path.join(box0Dir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(box0Dir, 'logs'), { recursive: true });
    fs.writeFileSync(hookScriptPath, buildHookScript(box0Dir, box0Wrapper), { mode: 0o755 });
  });

  after(() => {
    // Close DB before cleanup
    try {
      const { closeDb } = require('../lib/db');
      closeDb();
    } catch { /* ignore */ }

    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });

    if (origBox0Dir !== undefined) {
      process.env.BOX0_DIR = origBox0Dir;
    } else {
      delete process.env.BOX0_DIR;
    }
  });

  test('first Stop: imports session and messages into SQLite', () => {
    writeJSONL(transcriptPath, [
      makeEntry('user', 'What is TypeScript?', '2024-06-01T10:00:00.000Z'),
      makeEntry('assistant', 'TypeScript is a typed superset of JavaScript.', '2024-06-01T10:00:05.000Z'),
    ]);

    fireStopHook(hookScriptPath, transcriptPath);

    // Verify DB state via box0's own modules (they respect BOX0_DIR env)
    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ id: string; agent: string; title: string; message_count: number; source_path: string }>;
    assert.strictEqual(sessions.length, 1, 'should have exactly 1 session');
    assert.strictEqual(sessions[0].agent, 'claude-code');
    assert.ok(sessions[0].title!.includes('What is TypeScript'), 'title should come from first user message');
    assert.strictEqual(sessions[0].source_path, transcriptPath);

    const messages = db.prepare('SELECT * FROM messages ORDER BY seq ASC').all() as Array<{ role: string; content: string; seq: number }>;
    assert.strictEqual(messages.length, 2, 'should have 2 messages');
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content, 'What is TypeScript?');
    assert.strictEqual(messages[1].role, 'assistant');
    assert.ok(messages[1].content.includes('typed superset'));
  });

  test('incremental Stop: appended messages are imported, existing are not duplicated', () => {
    appendJSONL(transcriptPath, [
      makeEntry('user', 'Can you give an example?', '2024-06-01T10:01:00.000Z'),
      makeEntry('assistant', 'Sure: let x: number = 42;', '2024-06-01T10:01:05.000Z'),
    ]);

    fireStopHook(hookScriptPath, transcriptPath);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ id: string; message_count: number }>;
    assert.strictEqual(sessions.length, 1, 'should still have exactly 1 session');
    assert.strictEqual(sessions[0].message_count, 4, 'message_count should be 4');

    const messages = db.prepare('SELECT * FROM messages ORDER BY seq ASC').all() as Array<{ role: string; content: string; seq: number }>;
    assert.strictEqual(messages.length, 4, 'should have 4 messages total');
    assert.strictEqual(messages[2].role, 'user');
    assert.strictEqual(messages[2].content, 'Can you give an example?');
    assert.strictEqual(messages[3].role, 'assistant');
    assert.ok(messages[3].content.includes('let x: number'));
  });

  test('idempotent Stop: re-firing with no new messages does not create duplicates', () => {
    fireStopHook(hookScriptPath, transcriptPath);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ message_count: number }>;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].message_count, 4, 'message_count should still be 4');

    const msgCount = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.strictEqual(msgCount, 4, 'total messages should still be 4');
  });

  test('hook log contains timestamped entries', () => {
    const logPath = path.join(box0Dir, 'logs', 'hook.log');
    assert.ok(fs.existsSync(logPath), 'hook.log should exist');

    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.ok(logContent.includes('importing'), 'log should contain "importing" entries');
    assert.ok(logContent.includes('exit='), 'log should contain exit code entries');
    assert.ok(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(logContent), 'log should have timestamps');
  });

  test('stop_hook_active=true: hook exits without importing', () => {
    // Create a new transcript that has NOT been imported
    const freshPath = path.join(transcriptDir, 'should-not-import.jsonl');
    writeJSONL(freshPath, [
      makeEntry('user', 'this should not appear', '2024-06-01T12:00:00.000Z'),
    ]);

    fireStopHook(hookScriptPath, freshPath, { stopHookActive: true });

    const { getDb } = require('../lib/db');
    const db = getDb();

    // Should still only have the original session
    const sessions = db.prepare('SELECT * FROM sessions').all();
    assert.strictEqual(sessions.length, 1, 'should still have only 1 session (stop_hook_active prevented import)');

    const msgCount = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.strictEqual(msgCount, 4, 'should still have 4 messages');
  });
});
