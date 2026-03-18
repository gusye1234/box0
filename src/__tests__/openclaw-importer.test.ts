import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-openclaw-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJSONL(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function makeSessionEvent(timestamp = '2024-01-01T00:00:00.000Z') {
  return {
    type: 'session',
    id: crypto.randomUUID(),
    timestamp,
    cwd: '/home/user/project',
    version: 1,
  };
}

function makeMessageEvent(role: 'user' | 'assistant', content: object[], timestamp = '2024-01-01T00:01:00.000Z') {
  return {
    type: 'message',
    id: crypto.randomUUID(),
    parentId: null,
    timestamp,
    message: { role, content },
  };
}

// ─── extractText ──────────────────────────────────────────────────────────────

describe('extractText', () => {
  test('single text block returns the text trimmed', () => {
    const { extractText } = require('../importers/openclaw');
    assert.strictEqual(extractText([{ type: 'text', text: '  hello  ' }]), 'hello');
  });

  test('multiple text blocks joins with \\n\\n', () => {
    const { extractText } = require('../importers/openclaw');
    const blocks = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    assert.strictEqual(extractText(blocks), 'first\n\nsecond');
  });

  test('mixed content blocks returns only text parts', () => {
    const { extractText } = require('../importers/openclaw');
    const blocks = [
      { type: 'text', text: 'Hello' },
      { type: 'thinking', thinking: 'internal thought' },
      { type: 'toolCall', name: 'Bash', input: {} },
      { type: 'text', text: 'World' },
    ];
    assert.strictEqual(extractText(blocks), 'Hello\n\nWorld');
  });

  test('empty content array returns empty string', () => {
    const { extractText } = require('../importers/openclaw');
    assert.strictEqual(extractText([]), '');
  });
});

// ─── parseJSONLFile ───────────────────────────────────────────────────────────

describe('parseJSONLFile', () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('valid file returns correct sessionEvent and messageEvents', () => {
    const { parseJSONLFile } = require('../importers/openclaw');
    const filePath = path.join(tmpDir, 'valid.jsonl');
    writeJSONL(filePath, [
      makeSessionEvent('2024-01-01T00:00:00.000Z'),
      makeMessageEvent('user', [{ type: 'text', text: 'hello' }], '2024-01-01T00:01:00.000Z'),
      makeMessageEvent('assistant', [{ type: 'text', text: 'hi' }], '2024-01-01T00:02:00.000Z'),
    ]);
    const { sessionEvent, messageEvents } = parseJSONLFile(filePath);
    assert.ok(sessionEvent !== null);
    assert.strictEqual(sessionEvent.type, 'session');
    assert.strictEqual(messageEvents.length, 2);
    assert.strictEqual(messageEvents[0].message.role, 'user');
    assert.strictEqual(messageEvents[1].message.role, 'assistant');
  });

  test('skips non-message events (model_change, thinking_level_change)', () => {
    const { parseJSONLFile } = require('../importers/openclaw');
    const filePath = path.join(tmpDir, 'skip-events.jsonl');
    writeJSONL(filePath, [
      makeSessionEvent(),
      { type: 'model_change', model: 'claude-3' },
      { type: 'thinking_level_change', level: 'high' },
      { type: 'custom_event', data: {} },
      makeMessageEvent('user', [{ type: 'text', text: 'keep me' }]),
    ]);
    const { messageEvents } = parseJSONLFile(filePath);
    assert.strictEqual(messageEvents.length, 1);
    assert.strictEqual(messageEvents[0].message.role, 'user');
  });

  test('skips message events with roles other than user/assistant', () => {
    const { parseJSONLFile } = require('../importers/openclaw');
    const filePath = path.join(tmpDir, 'skip-roles.jsonl');
    writeJSONL(filePath, [
      makeSessionEvent(),
      { type: 'message', id: crypto.randomUUID(), parentId: null, timestamp: '2024-01-01T00:01:00.000Z', message: { role: 'system', content: [] } },
      makeMessageEvent('user', [{ type: 'text', text: 'valid' }]),
    ]);
    const { messageEvents } = parseJSONLFile(filePath);
    assert.strictEqual(messageEvents.length, 1);
    assert.strictEqual(messageEvents[0].message.role, 'user');
  });

  test('malformed JSON lines log warning and continue parsing', () => {
    const { parseJSONLFile } = require('../importers/openclaw');
    const filePath = path.join(tmpDir, 'malformed.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(makeSessionEvent()),
        JSON.stringify(makeMessageEvent('user', [{ type: 'text', text: 'valid before' }])),
        'THIS IS NOT JSON {{{',
        JSON.stringify(makeMessageEvent('assistant', [{ type: 'text', text: 'valid after' }])),
      ].join('\n') + '\n',
      'utf8'
    );
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnMessages.push(msg); };
    try {
      const { sessionEvent, messageEvents } = parseJSONLFile(filePath);
      assert.ok(sessionEvent !== null);
      assert.strictEqual(messageEvents.length, 2);
      assert.ok(warnMessages.some((m) => m.includes('malformed JSON')));
    } finally {
      console.warn = origWarn;
    }
  });

  test('missing session event returns sessionEvent: null', () => {
    const { parseJSONLFile } = require('../importers/openclaw');
    const filePath = path.join(tmpDir, 'no-session.jsonl');
    writeJSONL(filePath, [
      makeMessageEvent('user', [{ type: 'text', text: 'orphan message' }]),
    ]);
    const { sessionEvent, messageEvents } = parseJSONLFile(filePath);
    assert.strictEqual(sessionEvent, null);
    assert.strictEqual(messageEvents.length, 1);
  });
});

// ─── buildSession ─────────────────────────────────────────────────────────────

describe('buildSession', () => {
  test('session id equals SHA-1 of source_path', () => {
    const { buildSession } = require('../importers/openclaw');
    const filePath = '/tmp/openclaw-test-deterministic.jsonl';
    const sessionEvent = makeSessionEvent('2024-01-01T00:00:00.000Z');
    const messageEvents = [makeMessageEvent('user', [{ type: 'text', text: 'hi' }])];
    const s1 = buildSession(filePath, sessionEvent, messageEvents);
    const s2 = buildSession(filePath, sessionEvent, messageEvents);
    assert.strictEqual(s1.id, s2.id);
    const expected = crypto.createHash('sha1').update(filePath).digest('hex');
    assert.strictEqual(s1.id, expected);
  });

  test('agent field equals openclaw', () => {
    const { buildSession } = require('../importers/openclaw');
    const s = buildSession(
      '/tmp/agent.jsonl',
      makeSessionEvent(),
      [makeMessageEvent('user', [{ type: 'text', text: 'hi' }])]
    );
    assert.strictEqual(s.agent, 'openclaw');
  });

  test('title is first user message text truncated to 120 chars', () => {
    const { buildSession } = require('../importers/openclaw');
    const longText = 'x'.repeat(200);
    const s = buildSession(
      '/tmp/title.jsonl',
      makeSessionEvent(),
      [makeMessageEvent('user', [{ type: 'text', text: longText }])]
    );
    assert.ok(s.title !== null);
    assert.ok((s.title as string).length <= 120);
  });

  test('title is null when no user messages exist', () => {
    const { buildSession } = require('../importers/openclaw');
    const s = buildSession(
      '/tmp/no-user.jsonl',
      makeSessionEvent(),
      [makeMessageEvent('assistant', [{ type: 'text', text: 'response' }])]
    );
    assert.strictEqual(s.title, null);
  });

  test('created_at derived from session event timestamp', () => {
    const { buildSession } = require('../importers/openclaw');
    const sessionTs = '2024-06-15T10:00:00.000Z';
    const s = buildSession(
      '/tmp/created.jsonl',
      makeSessionEvent(sessionTs),
      [makeMessageEvent('user', [{ type: 'text', text: 'hi' }], '2024-06-15T10:01:00.000Z')]
    );
    assert.strictEqual(s.created_at, new Date(sessionTs).getTime());
  });

  test('updated_at equals the latest message event timestamp', () => {
    const { buildSession } = require('../importers/openclaw');
    const events = [
      makeMessageEvent('user', [{ type: 'text', text: 'msg1' }], '2024-01-01T00:01:00.000Z'),
      makeMessageEvent('assistant', [{ type: 'text', text: 'msg2' }], '2024-01-01T00:05:00.000Z'),
      makeMessageEvent('user', [{ type: 'text', text: 'msg3' }], '2024-01-01T00:03:00.000Z'),
    ];
    const s = buildSession('/tmp/updated.jsonl', makeSessionEvent('2024-01-01T00:00:00.000Z'), events);
    assert.strictEqual(s.updated_at, new Date('2024-01-01T00:05:00.000Z').getTime());
  });

  test('updated_at falls back to created_at when no message timestamps are available', () => {
    const { buildSession } = require('../importers/openclaw');
    const sessionTs = '2024-01-01T00:00:00.000Z';
    // events with no timestamp field
    const events = [
      { type: 'message', id: 'x', parentId: null, timestamp: '', message: { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] } },
    ];
    const s = buildSession('/tmp/fallback.jsonl', makeSessionEvent(sessionTs), events);
    assert.strictEqual(s.updated_at, s.created_at);
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

  test('happy path: inserts 1 session + N messages', () => {
    const { importFile } = require('../importers/openclaw');
    const filePath = path.join(sessionsDir, `${crypto.randomUUID()}.jsonl`);
    writeJSONL(filePath, [
      makeSessionEvent('2024-01-01T00:00:00.000Z'),
      makeMessageEvent('user', [{ type: 'text', text: 'hello' }], '2024-01-01T00:01:00.000Z'),
      makeMessageEvent('assistant', [{ type: 'text', text: 'hi there' }], '2024-01-01T00:02:00.000Z'),
    ]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, true);
    assert.strictEqual(result.messageCount, 2);
  });

  test('already-imported session upserts and reports 0 new messages', () => {
    const { importFile } = require('../importers/openclaw');
    const filePath = path.join(sessionsDir, `${crypto.randomUUID()}.jsonl`);
    writeJSONL(filePath, [
      makeSessionEvent(),
      makeMessageEvent('user', [{ type: 'text', text: 'first call' }]),
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(first.messageCount, 1);
    const second = importFile(filePath);
    assert.strictEqual(second.inserted, false);
    assert.strictEqual(second.messageCount, 1);
    assert.strictEqual(second.newMessages, 0);
  });

  test('file with no session event returns inserted:false', () => {
    const { importFile } = require('../importers/openclaw');
    const filePath = path.join(sessionsDir, `${crypto.randomUUID()}.jsonl`);
    writeJSONL(filePath, [
      makeMessageEvent('user', [{ type: 'text', text: 'orphan' }]),
    ]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, false);
    assert.strictEqual(result.messageCount, 0);
  });

  test('file with no message events returns inserted:false', () => {
    const { importFile } = require('../importers/openclaw');
    const filePath = path.join(sessionsDir, `${crypto.randomUUID()}.jsonl`);
    writeJSONL(filePath, [
      makeSessionEvent(),
    ]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, false);
    assert.strictEqual(result.messageCount, 0);
  });
});

describe('importAll', () => {
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
    // Clear sessions dir for each test
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  test('skips .deleted. files', () => {
    const { importAll } = require('../importers/openclaw');
    const uuid = crypto.randomUUID();
    writeJSONL(path.join(sessionsDir, `${uuid}.jsonl.deleted.1700000000000`), [
      makeSessionEvent(),
      makeMessageEvent('user', [{ type: 'text', text: 'deleted session' }]),
    ]);
    const result = importAll(sessionsDir);
    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(result.skipped, 0);
  });

  test('skips non-.jsonl files (e.g. sessions.json)', () => {
    const { importAll } = require('../importers/openclaw');
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({ sessions: [] }));
    const result = importAll(sessionsDir);
    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(result.skipped, 0);
  });

  test('processes multiple sessions, accumulates inserted and skipped counts', () => {
    const { importAll } = require('../importers/openclaw');

    // Write 3 valid session files
    for (let i = 0; i < 3; i++) {
      writeJSONL(path.join(sessionsDir, `${crypto.randomUUID()}.jsonl`), [
        makeSessionEvent('2024-01-01T00:00:00.000Z'),
        makeMessageEvent('user', [{ type: 'text', text: `message ${i}` }]),
      ]);
    }

    const result = importAll(sessionsDir);
    assert.strictEqual(result.inserted, 3);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.messages, 3);
  });

  test('non-existent directory returns { inserted: 0, skipped: 0, messages: 0 } silently', () => {
    const { importAll } = require('../importers/openclaw');
    const nonExistent = path.join(os.tmpdir(), 'box0-nonexistent-' + crypto.randomBytes(4).toString('hex'));
    const result = importAll(nonExistent);
    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.messages, 0);
  });

  test('invokes onFile callback for each processed file with correct result', () => {
    const { importAll } = require('../importers/openclaw');

    const uuid1 = crypto.randomUUID();
    const uuid2 = crypto.randomUUID();
    writeJSONL(path.join(sessionsDir, `${uuid1}.jsonl`), [
      makeSessionEvent(),
      makeMessageEvent('user', [{ type: 'text', text: 'first' }]),
    ]);
    writeJSONL(path.join(sessionsDir, `${uuid2}.jsonl`), [
      makeSessionEvent(),
      makeMessageEvent('user', [{ type: 'text', text: 'second' }]),
    ]);

    const callbacks: Array<{ filePath: string; result: { inserted: boolean; messageCount: number } }> = [];
    importAll(sessionsDir, (filePath: string, result: { inserted: boolean; messageCount: number }) => {
      callbacks.push({ filePath, result });
    });

    assert.strictEqual(callbacks.length, 2);
    assert.ok(callbacks.every((c) => c.result.inserted === true));
    assert.ok(callbacks.every((c) => c.result.messageCount === 1));
  });

  test('defaultBasePath returns path ending in /.openclaw/agents/main/sessions by default', () => {
    const origEnv = process.env.OPENCLAW_DIR;
    delete process.env.OPENCLAW_DIR;
    // Re-require to pick up env change (module is cached but function reads env at call time)
    const { defaultBasePath } = require('../importers/openclaw');
    const result = defaultBasePath();
    assert.ok(result.endsWith(path.join('.openclaw', 'agents', 'main', 'sessions')));
    if (origEnv !== undefined) process.env.OPENCLAW_DIR = origEnv;
  });

  test('defaultBasePath with OPENCLAW_DIR env returns $OPENCLAW_DIR/agents/main/sessions', () => {
    const customBase = '/custom/openclaw/dir';
    process.env.OPENCLAW_DIR = customBase;
    const { defaultBasePath } = require('../importers/openclaw');
    const result = defaultBasePath();
    assert.strictEqual(result, path.join(customBase, 'agents', 'main', 'sessions'));
    delete process.env.OPENCLAW_DIR;
  });
});
