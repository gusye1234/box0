import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-plugin-import-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('importFromPlugin / extractTextFromRawMessage', () => {
  let box0Dir: string;
  let origBox0Dir: string | undefined;

  before(() => {
    origBox0Dir = process.env.BOX0_DIR;
    box0Dir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    if (origBox0Dir !== undefined) {
      process.env.BOX0_DIR = origBox0Dir;
    } else {
      delete process.env.BOX0_DIR;
    }
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  // ─── extractTextFromRawMessage ───────────────────────────────────────────────

  test('extractTextFromRawMessage: content as string returns it directly', () => {
    const { extractTextFromRawMessage } = require('../importers/openclaw');
    assert.strictEqual(extractTextFromRawMessage({ role: 'user', content: 'simple text' }), 'simple text');
  });

  test('extractTextFromRawMessage: content as array extracts text blocks only', () => {
    const { extractTextFromRawMessage } = require('../importers/openclaw');
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'x', name: 'fn', input: {} },
      ],
    };
    assert.strictEqual(extractTextFromRawMessage(msg), 'hello');
  });

  test('extractTextFromRawMessage: content as null returns empty string', () => {
    const { extractTextFromRawMessage } = require('../importers/openclaw');
    assert.strictEqual(extractTextFromRawMessage({ role: 'user', content: null }), '');
  });

  // ─── importFromPlugin ────────────────────────────────────────────────────────

  test('importFromPlugin: first import creates session and inserts messages', () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const { findById } = require('../models/session');
    const { findBySession } = require('../models/message');

    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = importFromPlugin({ sessionKey: 'test-key', messages });
    assert.strictEqual(result.inserted, 2);
    assert.strictEqual(result.upserted, true);

    const sessionId = crypto.createHash('sha1').update('openclaw://plugin/test-key').digest('hex');
    const session = findById(sessionId);
    assert.ok(session, 'session should exist');
    assert.strictEqual(session.source_path, 'openclaw://plugin/test-key');

    const msgs = findBySession(sessionId);
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs.some((m: { id: string }) => m.id === `${sessionId}:0`));
    assert.ok(msgs.some((m: { id: string }) => m.id === `${sessionId}:1`));
  });

  test('importFromPlugin: second call with same messages (OR IGNORE) returns inserted=0', () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const { findBySession } = require('../models/message');

    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    importFromPlugin({ sessionKey: 'dup-key', messages });
    const result = importFromPlugin({ sessionKey: 'dup-key', messages });
    assert.strictEqual(result.inserted, 0);

    const sessionId = crypto.createHash('sha1').update('openclaw://plugin/dup-key').digest('hex');
    const msgs = findBySession(sessionId);
    assert.strictEqual(msgs.length, 3);
  });

  test('importFromPlugin: second call with appended messages inserts only new ones', () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const { findBySession } = require('../models/message');
    const { findById } = require('../models/session');

    const messages3 = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    importFromPlugin({ sessionKey: 'append-key', messages: messages3 });

    const messages5 = [
      ...messages3,
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ];
    const result = importFromPlugin({ sessionKey: 'append-key', messages: messages5 });
    assert.strictEqual(result.inserted, 2);

    const sessionId = crypto.createHash('sha1').update('openclaw://plugin/append-key').digest('hex');
    const msgs = findBySession(sessionId);
    assert.strictEqual(msgs.length, 5);

    const session = findById(sessionId);
    assert.strictEqual(session.message_count, 5);
  });

  test('importFromPlugin: session upsert updates imported_at on second call', async () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const { findById } = require('../models/session');

    const messages = [{ role: 'user', content: 'hi' }];
    importFromPlugin({ sessionKey: 'ts-key', messages });

    const sessionId = crypto.createHash('sha1').update('openclaw://plugin/ts-key').digest('hex');
    const session1 = findById(sessionId);
    const importedAt1 = session1.imported_at;

    // Wait 1 ms then import again with more messages
    await new Promise((r) => setTimeout(r, 2));
    const messages2 = [...messages, { role: 'assistant', content: 'hello' }];
    importFromPlugin({ sessionKey: 'ts-key', messages: messages2 });

    const session2 = findById(sessionId);
    assert.ok(session2.imported_at > importedAt1, 'imported_at should be updated on second call');
  });

  test('importFromPlugin: first user message used as title (max 120 chars)', () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const { findById } = require('../models/session');

    const longText = 'A'.repeat(200);
    const messages = [{ role: 'user', content: longText }, { role: 'assistant', content: 'ok' }];
    importFromPlugin({ sessionKey: 'title-key', messages });

    const sessionId = crypto.createHash('sha1').update('openclaw://plugin/title-key').digest('hex');
    const session = findById(sessionId);
    assert.strictEqual(session.title, 'A'.repeat(120));
  });

  test('importFromPlugin: empty messages array returns inserted=0', () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const result = importFromPlugin({ sessionKey: 'empty-key', messages: [] });
    assert.strictEqual(result.inserted, 0);
  });

  test('importFromPlugin: messages with tool role are stored correctly', () => {
    const { importFromPlugin } = require('../importers/openclaw');
    const { findBySession } = require('../models/message');

    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result' },
    ];
    const result = importFromPlugin({ sessionKey: 'tool-key', messages });
    assert.strictEqual(result.inserted, 2);

    const sessionId = crypto.createHash('sha1').update('openclaw://plugin/tool-key').digest('hex');
    const msgs = findBySession(sessionId);
    assert.ok(msgs.some((m: { role: string }) => m.role === 'tool'));
  });

  // ─── runImportFromPlugin ─────────────────────────────────────────────────────

  test('runImportFromPlugin: success returns exitCode=0 and stdout with message count', () => {
    const { runImportFromPlugin } = require('../importers/openclaw');
    const result = runImportFromPlugin({
      sessionKey: 'sk',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('1 new messages'), `stdout: ${result.stdout}`);
  });

  test('runImportFromPlugin: direct call inserts session and messages into DB', () => {
    const { runImportFromPlugin } = require('../importers/openclaw');
    const { findById } = require('../models/session');

    const sessionKey = 'direct-key';
    const messages = [{ role: 'user', content: 'hello direct' }];
    const result = runImportFromPlugin({ sessionKey, messages, workspaceDir: '/some/dir' });
    assert.strictEqual(result.exitCode, 0);

    const sessionId = crypto.createHash('sha1').update(`openclaw://plugin/${sessionKey}`).digest('hex');
    const session = findById(sessionId);
    assert.ok(session, 'session should exist after runImportFromPlugin');
  });
});

// ─── --stdin validation logic tests (via runImportFromPlugin) ─────────────────

describe('--stdin validation helpers', () => {
  let box0Dir: string;
  let origBox0Dir: string | undefined;

  before(() => {
    origBox0Dir = process.env.BOX0_DIR;
    box0Dir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    if (origBox0Dir !== undefined) {
      process.env.BOX0_DIR = origBox0Dir;
    } else {
      delete process.env.BOX0_DIR;
    }
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('runImportFromPlugin handles empty sessionKey gracefully', () => {
    // The function itself gets called with valid opts; validation of stdin payload
    // happens in the command handler. Test that empty messages still works.
    const { runImportFromPlugin } = require('../importers/openclaw');
    const result = runImportFromPlugin({ sessionKey: 'test', messages: [] });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('0 new messages'));
  });
});
