import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

function makeTempDir(label: string): string {
  const dir = path.join(os.tmpdir(), `box0-e2e-oc-${label}-${crypto.randomBytes(4).toString('hex')}`);
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

function runBox0(box0Dir: string, args: string[], opts?: { input?: string }): string {
  return execFileSync(getNodePath(), [getBox0Entry(), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, BOX0_DIR: box0Dir },
    input: opts?.input,
  });
}

describe('e2e: OpenClaw plugin full pipeline (--stdin)', () => {
  let box0Dir: string;
  let origBox0Dir: string | undefined;
  const sessionKey = `e2e-test-${crypto.randomBytes(4).toString('hex')}`;

  before(() => {
    origBox0Dir = process.env.BOX0_DIR;
    box0Dir = makeTempDir('box0dir');
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    try {
      const { closeDb } = require('../lib/db');
      closeDb();
    } catch { /* ignore */ }

    fs.rmSync(box0Dir, { recursive: true, force: true });

    if (origBox0Dir !== undefined) {
      process.env.BOX0_DIR = origBox0Dir;
    } else {
      delete process.env.BOX0_DIR;
    }
  });

  test('first stdin import: session + messages in SQLite', () => {
    const payload = JSON.stringify({
      sessionKey,
      messages: [
        { role: 'user', content: 'What is Rust?' },
        { role: 'assistant', content: 'Rust is a systems programming language.' },
      ],
    });

    const stdout = runBox0(box0Dir, ['import', 'openclaw', '--stdin'], { input: payload });
    assert.ok(stdout.includes('2 new messages'), `stdout: ${stdout}`);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ agent: string; title: string; message_count: number; source_path: string }>;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].agent, 'openclaw');
    assert.ok(sessions[0].title!.includes('What is Rust'));
    assert.ok(sessions[0].source_path.includes(sessionKey));

    const messages = db.prepare('SELECT * FROM messages ORDER BY seq ASC').all() as Array<{ role: string; content: string }>;
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content, 'What is Rust?');
    assert.strictEqual(messages[1].role, 'assistant');
    assert.ok(messages[1].content.includes('systems programming'));
  });

  test('incremental stdin import: appended messages → only new ones inserted', () => {
    const payload = JSON.stringify({
      sessionKey,
      messages: [
        { role: 'user', content: 'What is Rust?' },
        { role: 'assistant', content: 'Rust is a systems programming language.' },
        { role: 'user', content: 'Show me an example' },
        { role: 'assistant', content: 'fn main() { println!("Hello"); }' },
      ],
    });

    const stdout = runBox0(box0Dir, ['import', 'openclaw', '--stdin'], { input: payload });
    assert.ok(stdout.includes('2 new messages'), `stdout: ${stdout}`);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{ message_count: number }>;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].message_count, 4);

    const messages = db.prepare('SELECT * FROM messages ORDER BY seq ASC').all() as Array<{ role: string; content: string }>;
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[2].role, 'user');
    assert.strictEqual(messages[2].content, 'Show me an example');
    assert.ok(messages[3].content.includes('println'));
  });

  test('idempotent stdin import: same payload → 0 new messages', () => {
    const payload = JSON.stringify({
      sessionKey,
      messages: [
        { role: 'user', content: 'What is Rust?' },
        { role: 'assistant', content: 'Rust is a systems programming language.' },
        { role: 'user', content: 'Show me an example' },
        { role: 'assistant', content: 'fn main() { println!("Hello"); }' },
      ],
    });

    const stdout = runBox0(box0Dir, ['import', 'openclaw', '--stdin'], { input: payload });
    assert.ok(stdout.includes('0 new messages'), `stdout: ${stdout}`);

    const { getDb } = require('../lib/db');
    const db = getDb();

    const msgCount = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.strictEqual(msgCount, 4);
  });
});
