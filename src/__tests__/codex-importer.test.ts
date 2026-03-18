import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-codex-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJSONL(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function makeThreadStarted(sessionId: string = crypto.randomUUID(), timestamp = '2026-03-01T10:00:00.000Z') {
  return { type: 'thread.started', session_id: sessionId, timestamp };
}

function makeTurnItem(role: 'user' | 'assistant', text: string, timestamp?: string) {
  const item: Record<string, unknown> = { role, content: text };
  if (timestamp) item.timestamp = timestamp;
  return item;
}

// ─── extractText ─────────────────────────────────────────────────────────────

describe('extractText', () => {
  test('string content returns the string', () => {
    const { extractText } = require('../importers/codex');
    const item = { role: 'user', content: 'hello world' };
    assert.strictEqual(extractText(item), 'hello world');
  });

  test('array content with text blocks returns joined text', () => {
    const { extractText } = require('../importers/codex');
    const item = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
      ],
    };
    assert.strictEqual(extractText(item), 'hello world');
  });

  test('array content with mixed types returns only text blocks', () => {
    const { extractText } = require('../importers/codex');
    const item = {
      role: 'user',
      content: [
        { type: 'text', text: 'visible' },
        { type: 'tool_call', text: 'ignored' },
        { type: 'text', text: ' part2' },
      ],
    };
    assert.strictEqual(extractText(item), 'visible part2');
  });

  test('missing text field in block returns empty string for that block', () => {
    const { extractText } = require('../importers/codex');
    const item = {
      role: 'user',
      content: [{ type: 'text' }],
    };
    assert.strictEqual(extractText(item), '');
  });

  test('missing content returns empty string', () => {
    const { extractText } = require('../importers/codex');
    const item = { role: 'user' };
    assert.strictEqual(extractText(item), '');
  });
});

// ─── parseJSONLFile ───────────────────────────────────────────────────────────

describe('parseJSONLFile', () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('well-formed JSONL returns correct threadStarted + user/assistant items', () => {
    const { parseJSONLFile } = require('../importers/codex');
    const filePath = path.join(tmpDir, 'rollout-abc.jsonl');
    writeJSONL(filePath, [
      makeThreadStarted('sess1'),
      makeTurnItem('user', 'what is 2+2?'),
      makeTurnItem('assistant', '4'),
    ]);
    const { threadStarted, items } = parseJSONLFile(filePath);
    assert.ok(threadStarted !== null);
    assert.strictEqual((threadStarted as { session_id: string }).session_id, 'sess1');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].role, 'user');
    assert.strictEqual(items[1].role, 'assistant');
  });

  test('malformed line is skipped with warning', () => {
    const { parseJSONLFile } = require('../importers/codex');
    const filePath = path.join(tmpDir, 'rollout-bad.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(makeThreadStarted()),
        JSON.stringify(makeTurnItem('user', 'valid before')),
        'NOT VALID JSON {{{',
        JSON.stringify(makeTurnItem('assistant', 'valid after')),
      ].join('\n') + '\n',
      'utf8'
    );
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnMessages.push(msg); };
    try {
      const { items } = parseJSONLFile(filePath);
      assert.strictEqual(items.length, 2);
      assert.ok(warnMessages.some((m) => m.includes('malformed JSON')));
    } finally {
      console.warn = origWarn;
    }
  });

  test('events without user/assistant role are skipped', () => {
    const { parseJSONLFile } = require('../importers/codex');
    const filePath = path.join(tmpDir, 'rollout-nonu.jsonl');
    writeJSONL(filePath, [
      makeThreadStarted(),
      { type: 'some_event', data: 'ignored' },
      makeTurnItem('user', 'only user/assistant'),
    ]);
    const { items } = parseJSONLFile(filePath);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].role, 'user');
  });
});

// ─── buildSession ─────────────────────────────────────────────────────────────

describe('buildSession', () => {
  test('session id is SHA-1 of filePath', () => {
    const { buildSession } = require('../importers/codex');
    const filePath = '/tmp/codex-test-stable.jsonl';
    const items = [makeTurnItem('user', 'hello'), makeTurnItem('assistant', 'hi')];
    const s1 = buildSession(filePath, makeThreadStarted(), items);
    const s2 = buildSession(filePath, makeThreadStarted(), items);
    assert.strictEqual(s1.id, s2.id);
    const expected = crypto.createHash('sha1').update(filePath).digest('hex');
    assert.strictEqual(s1.id, expected);
  });

  test('title is first user item text (≤120 chars)', () => {
    const { buildSession } = require('../importers/codex');
    const longText = 'a'.repeat(200);
    const items = [makeTurnItem('user', longText), makeTurnItem('assistant', 'ok')];
    const session = buildSession('/tmp/title.jsonl', makeThreadStarted(), items);
    assert.ok(session.title !== null);
    assert.ok((session.title as string).length <= 120);
  });

  test('agent is "codex"', () => {
    const { buildSession } = require('../importers/codex');
    const session = buildSession('/tmp/agent.jsonl', makeThreadStarted(), [makeTurnItem('user', 'hi')]);
    assert.strictEqual(session.agent, 'codex');
  });
});

// ─── DB-touching tests: importFile / importAll ────────────────────────────────

describe('importFile', () => {
  let box0Dir: string;
  let sessionsDir: string;

  before(() => {
    box0Dir = makeTempDir();
    sessionsDir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('happy path: session + messages inserted', () => {
    const { importFile } = require('../importers/codex');
    const filePath = path.join(sessionsDir, `rollout-${crypto.randomBytes(4).toString('hex')}.jsonl`);
    writeJSONL(filePath, [
      makeThreadStarted(),
      makeTurnItem('user', 'what is the weather?'),
      makeTurnItem('assistant', 'sunny'),
    ]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, true);
    assert.strictEqual(result.messageCount, 2);
  });

  test('second call on same file upserts and reports 0 new messages', () => {
    const { importFile } = require('../importers/codex');
    const filePath = path.join(sessionsDir, `rollout-${crypto.randomBytes(4).toString('hex')}.jsonl`);
    writeJSONL(filePath, [
      makeThreadStarted(),
      makeTurnItem('user', 'hello'),
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(first.messageCount, 1);
    const second = importFile(filePath);
    assert.strictEqual(second.inserted, false);
    assert.strictEqual(second.messageCount, 1);
    assert.strictEqual(second.newMessages, 0);
  });

  test('file with no turn items returns inserted:false', () => {
    const { importFile } = require('../importers/codex');
    const filePath = path.join(sessionsDir, `rollout-${crypto.randomBytes(4).toString('hex')}.jsonl`);
    writeJSONL(filePath, [makeThreadStarted()]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, false);
    assert.strictEqual(result.messageCount, 0);
  });
});

describe('importAll', () => {
  let box0Dir: string;
  let baseDir: string;

  before(() => {
    box0Dir = makeTempDir();
    baseDir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
    // Reset baseDir for each test (clean slate)
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.mkdirSync(baseDir, { recursive: true });
  });

  test('date-sharded directory structure traversed recursively', () => {
    const { importAll } = require('../importers/codex');
    // Create YYYY/MM/DD/rollout-*.jsonl structure
    const dateDir1 = path.join(baseDir, '2026', '03', '01');
    const dateDir2 = path.join(baseDir, '2026', '03', '02');
    fs.mkdirSync(dateDir1, { recursive: true });
    fs.mkdirSync(dateDir2, { recursive: true });

    writeJSONL(path.join(dateDir1, 'rollout-abc123.jsonl'), [
      makeThreadStarted(),
      makeTurnItem('user', 'day1 question'),
      makeTurnItem('assistant', 'day1 answer'),
    ]);
    writeJSONL(path.join(dateDir2, 'rollout-def456.jsonl'), [
      makeThreadStarted(),
      makeTurnItem('user', 'day2 question'),
    ]);

    const result = importAll(baseDir);
    assert.strictEqual(result.inserted, 2);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.messages, 3);
  });

  test('empty/missing directory returns { inserted: 0, skipped: 0, messages: 0 } without crash', () => {
    const { importAll } = require('../importers/codex');
    const nonExistent = path.join(os.tmpdir(), 'box0-codex-nonexistent-' + crypto.randomBytes(4).toString('hex'));
    const result = importAll(nonExistent);
    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.messages, 0);
  });

  test('ignores non-JSONL files and non-rollout JSONL files', () => {
    const { importAll } = require('../importers/codex');
    const dateDir = path.join(baseDir, '2026', '03', '01');
    fs.mkdirSync(dateDir, { recursive: true });

    // non-JSONL
    fs.writeFileSync(path.join(dateDir, 'readme.txt'), 'ignored', 'utf8');
    // JSONL but not rollout-* named
    writeJSONL(path.join(dateDir, 'history.jsonl'), [makeTurnItem('user', 'ignored')]);
    // Valid rollout
    writeJSONL(path.join(dateDir, 'rollout-valid.jsonl'), [
      makeThreadStarted(),
      makeTurnItem('user', 'valid'),
    ]);

    const result = importAll(baseDir);
    assert.strictEqual(result.inserted, 1);
  });

  test('onFile callback is called with (filePath, result) for each processed file', () => {
    const { importAll } = require('../importers/codex');
    const dateDir = path.join(baseDir, '2026', '03', '01');
    fs.mkdirSync(dateDir, { recursive: true });

    writeJSONL(path.join(dateDir, 'rollout-a.jsonl'), [
      makeThreadStarted(),
      makeTurnItem('user', 'msg a'),
    ]);
    writeJSONL(path.join(dateDir, 'rollout-b.jsonl'), [
      makeThreadStarted(),
      makeTurnItem('user', 'msg b'),
    ]);

    const callbacks: Array<{ filePath: string; result: { inserted: boolean; messageCount: number } }> = [];
    importAll(baseDir, (filePath: string, result: { inserted: boolean; messageCount: number }) => {
      callbacks.push({ filePath, result });
    });

    assert.strictEqual(callbacks.length, 2);
    assert.ok(callbacks.every((c) => c.result.inserted === true));
    assert.ok(callbacks.every((c) => c.result.messageCount === 1));
  });

  test('defaultBasePath uses CODEX_DIR env override when set', () => {
    const { defaultBasePath } = require('../importers/codex');
    process.env.CODEX_DIR = '/custom/codex/sessions';
    const result = defaultBasePath();
    assert.strictEqual(result, '/custom/codex/sessions');
    delete process.env.CODEX_DIR;
  });

  test('defaultBasePath returns ~/.codex/sessions by default', () => {
    const origEnv = process.env.CODEX_DIR;
    delete process.env.CODEX_DIR;
    const { defaultBasePath } = require('../importers/codex');
    const result = defaultBasePath();
    assert.ok(result.endsWith(path.join('.codex', 'sessions')));
    if (origEnv !== undefined) process.env.CODEX_DIR = origEnv;
  });
});
