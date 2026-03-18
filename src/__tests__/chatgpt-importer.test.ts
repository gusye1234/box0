import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-chatgpt-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeNode(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant' | 'system',
  text: string,
  opts: { weight?: number; hidden?: boolean } = {}
) {
  return {
    id,
    message: {
      id,
      author: { role },
      content: { content_type: 'text', parts: [text] },
      create_time: 1700000000,
      weight: opts.weight ?? 1,
      metadata: {
        is_visually_hidden_from_conversation: opts.hidden ?? false,
      },
    },
    parent: parentId,
    children: [] as string[],
  };
}

function makeConversation(id: string, nodes: ReturnType<typeof makeNode>[], currentNode: string) {
  const mapping: Record<string, ReturnType<typeof makeNode>> = {};
  for (const n of nodes) mapping[n.id] = n;
  return {
    id,
    title: 'Test conversation',
    create_time: 1700000000,
    update_time: 1700003600,
    current_node: currentNode,
    mapping,
  };
}

// ─── extractText ─────────────────────────────────────────────────────────────

describe('extractText', () => {
  test('content_type text with parts array returns joined string', () => {
    const { extractText } = require('../importers/chatgpt');
    const content = { content_type: 'text', parts: ['hello', ' world'] };
    assert.strictEqual(extractText(content), 'hello world');
  });

  test('unknown content type returns empty string', () => {
    const { extractText } = require('../importers/chatgpt');
    const content = { content_type: 'multimodal_text', parts: ['ignored'] };
    assert.strictEqual(extractText(content), '');
  });

  test('text content type with non-string parts filters them out', () => {
    const { extractText } = require('../importers/chatgpt');
    const content = { content_type: 'text', parts: ['hello', null, 'world'] };
    assert.strictEqual(extractText(content), 'hello world');
  });

  test('text content type with no parts returns empty string', () => {
    const { extractText } = require('../importers/chatgpt');
    const content = { content_type: 'text' };
    assert.strictEqual(extractText(content), '');
  });
});

// ─── walkMapping ─────────────────────────────────────────────────────────────

describe('walkMapping', () => {
  test('linear chain returns root-to-leaf order', () => {
    const { walkMapping } = require('../importers/chatgpt');
    const n1 = makeNode('n1', null, 'system', 'system prompt');
    const n2 = makeNode('n2', 'n1', 'user', 'hello');
    const n3 = makeNode('n3', 'n2', 'assistant', 'hi there');
    const mapping = { n1, n2, n3 };
    const result = walkMapping(mapping, 'n3');
    // n1 has weight 1 and no hidden, n2 and n3 same — all should be included
    const ids = result.map((n: { id: string }) => n.id);
    assert.deepStrictEqual(ids, ['n1', 'n2', 'n3']);
  });

  test('only current_node branch included (branched tree)', () => {
    const { walkMapping } = require('../importers/chatgpt');
    // n1 → n2 (branch A: n3, n4) and (branch B: n5 → current)
    const n1 = makeNode('n1', null, 'user', 'root');
    const n2 = makeNode('n2', 'n1', 'assistant', 'response');
    const n3 = makeNode('n3', 'n2', 'user', 'branch A');
    const n4 = makeNode('n4', 'n3', 'assistant', 'branch A reply');
    const n5 = makeNode('n5', 'n2', 'user', 'branch B');
    const n6 = makeNode('n6', 'n5', 'assistant', 'branch B reply');
    const mapping = { n1, n2, n3, n4, n5, n6 };
    const result = walkMapping(mapping, 'n6');
    const ids = result.map((n: { id: string }) => n.id);
    // Should be n1 → n2 → n5 → n6
    assert.deepStrictEqual(ids, ['n1', 'n2', 'n5', 'n6']);
    // Branch A nodes should NOT be included
    assert.ok(!ids.includes('n3'));
    assert.ok(!ids.includes('n4'));
  });

  test('node with weight 0 is excluded', () => {
    const { walkMapping } = require('../importers/chatgpt');
    const n1 = makeNode('n1', null, 'user', 'root');
    const n2 = makeNode('n2', 'n1', 'assistant', 'hidden', { weight: 0 });
    const n3 = makeNode('n3', 'n2', 'user', 'visible');
    const mapping = { n1, n2, n3 };
    const result = walkMapping(mapping, 'n3');
    const ids = result.map((n: { id: string }) => n.id);
    assert.ok(!ids.includes('n2'));
    assert.ok(ids.includes('n1'));
    assert.ok(ids.includes('n3'));
  });

  test('node with is_visually_hidden_from_conversation: true is excluded', () => {
    const { walkMapping } = require('../importers/chatgpt');
    const n1 = makeNode('n1', null, 'user', 'root');
    const n2 = makeNode('n2', 'n1', 'assistant', 'hidden', { hidden: true });
    const n3 = makeNode('n3', 'n2', 'user', 'visible');
    const mapping = { n1, n2, n3 };
    const result = walkMapping(mapping, 'n3');
    const ids = result.map((n: { id: string }) => n.id);
    assert.ok(!ids.includes('n2'));
    assert.ok(ids.includes('n1'));
    assert.ok(ids.includes('n3'));
  });
});

// ─── buildSession ─────────────────────────────────────────────────────────────

describe('buildSession', () => {
  test('session id is SHA-1 of "chatgpt:<conv.id>"', () => {
    const { buildSession } = require('../importers/chatgpt');
    const convId = '3a7b9f12-test-uuid';
    const conv = makeConversation(convId, [makeNode('n1', null, 'user', 'hello')], 'n1');
    const session = buildSession(conv);
    const expected = crypto.createHash('sha1').update('chatgpt:' + convId).digest('hex');
    assert.strictEqual(session.id, expected);
  });

  test('source_path is "chatgpt://<conv.id>"', () => {
    const { buildSession } = require('../importers/chatgpt');
    const convId = 'abc-123';
    const conv = makeConversation(convId, [makeNode('n1', null, 'user', 'hi')], 'n1');
    const session = buildSession(conv);
    assert.strictEqual(session.source_path, `chatgpt://${convId}`);
  });

  test('timestamps are in ms (create_time and update_time * 1000)', () => {
    const { buildSession } = require('../importers/chatgpt');
    const conv = {
      id: 'ts-test',
      title: 'TS test',
      create_time: 1700000000.5,
      update_time: 1700003600.25,
      current_node: 'n1',
      mapping: { n1: makeNode('n1', null, 'user', 'hi') },
    };
    const session = buildSession(conv);
    assert.strictEqual(session.created_at, Math.round(1700000000.5 * 1000));
    assert.strictEqual(session.updated_at, Math.round(1700003600.25 * 1000));
  });

  test('title truncated to 120 chars', () => {
    const { buildSession } = require('../importers/chatgpt');
    const longTitle = 'x'.repeat(200);
    const conv = {
      id: 'title-test',
      title: longTitle,
      create_time: 1700000000,
      update_time: 1700000000,
      current_node: 'n1',
      mapping: { n1: makeNode('n1', null, 'user', 'hi') },
    };
    const session = buildSession(conv);
    assert.ok(session.title !== null);
    assert.ok((session.title as string).length <= 120);
  });

  test('session id is stable across multiple calls', () => {
    const { buildSession } = require('../importers/chatgpt');
    const conv = makeConversation('stable-id', [makeNode('n1', null, 'user', 'hi')], 'n1');
    const s1 = buildSession(conv);
    const s2 = buildSession(conv);
    assert.strictEqual(s1.id, s2.id);
  });

  test('agent is "chatgpt"', () => {
    const { buildSession } = require('../importers/chatgpt');
    const conv = makeConversation('agent-test', [makeNode('n1', null, 'user', 'hi')], 'n1');
    const session = buildSession(conv);
    assert.strictEqual(session.agent, 'chatgpt');
  });
});

// ─── parseFile ───────────────────────────────────────────────────────────────

describe('parseFile', () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('valid file returns ChatGPTConversation[]', () => {
    const { parseFile } = require('../importers/chatgpt');
    const filePath = path.join(tmpDir, 'conversations.json');
    const conversations = [
      makeConversation('conv1', [makeNode('n1', null, 'user', 'hello')], 'n1'),
      makeConversation('conv2', [makeNode('n1', null, 'user', 'hello2')], 'n1'),
    ];
    fs.writeFileSync(filePath, JSON.stringify(conversations), 'utf8');
    const result = parseFile(filePath);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'conv1');
    assert.strictEqual(result[1].id, 'conv2');
  });

  test('missing file throws descriptive error', () => {
    const { parseFile } = require('../importers/chatgpt');
    const filePath = path.join(tmpDir, 'nonexistent.json');
    assert.throws(
      () => parseFile(filePath),
      (err: Error) => err.message.includes('Cannot read ChatGPT export file')
    );
  });

  test('malformed JSON throws descriptive error', () => {
    const { parseFile } = require('../importers/chatgpt');
    const filePath = path.join(tmpDir, 'malformed.json');
    fs.writeFileSync(filePath, '{not valid json', 'utf8');
    assert.throws(
      () => parseFile(filePath),
      (err: Error) => err.message.includes('malformed JSON')
    );
  });

  test('non-array JSON throws descriptive error', () => {
    const { parseFile } = require('../importers/chatgpt');
    const filePath = path.join(tmpDir, 'not-array.json');
    fs.writeFileSync(filePath, JSON.stringify({ conversations: [] }), 'utf8');
    assert.throws(
      () => parseFile(filePath),
      (err: Error) => err.message.includes('must be a JSON array')
    );
  });
});

// ─── importConversation / importFile ──────────────────────────────────────────

describe('importConversation', () => {
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

  test('happy path: session inserted, messages batched correctly', () => {
    const { importConversation } = require('../importers/chatgpt');
    const n1 = makeNode('n1', null, 'user', 'hello');
    const n2 = makeNode('n2', 'n1', 'assistant', 'hi there');
    const conv = makeConversation(crypto.randomUUID(), [n1, n2], 'n2');
    const result = importConversation(conv);
    assert.strictEqual(result.inserted, true);
    assert.strictEqual(result.messageCount, 2);
  });

  test('zero messages after filtering returns { inserted: false, messageCount: 0 } without DB row', () => {
    const { importConversation } = require('../importers/chatgpt');
    // All nodes hidden
    const n1 = makeNode('n1', null, 'user', 'hidden', { hidden: true });
    const conv = makeConversation(crypto.randomUUID(), [n1], 'n1');
    const result = importConversation(conv);
    assert.strictEqual(result.inserted, false);
    assert.strictEqual(result.messageCount, 0);
  });

  test('second call on same conversation is deduped', () => {
    const { importConversation } = require('../importers/chatgpt');
    const convId = crypto.randomUUID();
    const n1 = makeNode('n1', null, 'user', 'hello');
    const n2 = makeNode('n2', 'n1', 'assistant', 'hi');
    const conv = makeConversation(convId, [n1, n2], 'n2');
    const first = importConversation(conv);
    assert.strictEqual(first.inserted, true);
    const second = importConversation(conv);
    assert.strictEqual(second.inserted, false);
    assert.strictEqual(second.messageCount, 0);
  });
});

describe('importFile', () => {
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

  test('multi-conversation fixture returns correct inserted/skipped/messages counts', () => {
    const { importFile } = require('../importers/chatgpt');
    const filePath = path.join(tmpDir, 'multi.json');

    const n1a = makeNode('n1a', null, 'user', 'conv1 msg1');
    const n2a = makeNode('n2a', 'n1a', 'assistant', 'conv1 reply');
    const conv1 = makeConversation(crypto.randomUUID(), [n1a, n2a], 'n2a');

    // conv2: node hidden → 0 messages → skipped
    const n1b = makeNode('n1b', null, 'user', 'hidden', { hidden: true });
    const conv2 = makeConversation(crypto.randomUUID(), [n1b], 'n1b');

    const n1c = makeNode('n1c', null, 'user', 'conv3 msg');
    const conv3 = makeConversation(crypto.randomUUID(), [n1c], 'n1c');

    fs.writeFileSync(filePath, JSON.stringify([conv1, conv2, conv3]), 'utf8');

    const result = importFile(filePath);
    assert.strictEqual(result.inserted, 2);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.messages, 3); // 2 from conv1 + 1 from conv3
  });

  test('onConversation callback invoked with correct (conv, result) arguments', () => {
    const { importFile } = require('../importers/chatgpt');
    const filePath = path.join(tmpDir, 'callback.json');
    const n1 = makeNode('n1', null, 'user', 'hello');
    const n2 = makeNode('n2', 'n1', 'assistant', 'hi');
    const conv = makeConversation(crypto.randomUUID(), [n1, n2], 'n2');
    fs.writeFileSync(filePath, JSON.stringify([conv]), 'utf8');

    const callbacks: Array<{ convId: string; result: { inserted: boolean; messageCount: number } }> = [];
    importFile(filePath, (c: { id: string }, result: { inserted: boolean; messageCount: number }) => {
      callbacks.push({ convId: c.id, result });
    });

    assert.strictEqual(callbacks.length, 1);
    assert.strictEqual(callbacks[0].convId, conv.id);
    assert.strictEqual(callbacks[0].result.inserted, true);
    assert.strictEqual(callbacks[0].result.messageCount, 2);
  });

  test('defaultFilePath returns CHATGPT_EXPORT_FILE env when set', () => {
    const { defaultFilePath } = require('../importers/chatgpt');
    process.env.CHATGPT_EXPORT_FILE = '/custom/path/conversations.json';
    const result = defaultFilePath();
    assert.strictEqual(result, '/custom/path/conversations.json');
    delete process.env.CHATGPT_EXPORT_FILE;
  });

  test('defaultFilePath returns empty string when env not set', () => {
    const origEnv = process.env.CHATGPT_EXPORT_FILE;
    delete process.env.CHATGPT_EXPORT_FILE;
    const { defaultFilePath } = require('../importers/chatgpt');
    assert.strictEqual(defaultFilePath(), '');
    if (origEnv !== undefined) process.env.CHATGPT_EXPORT_FILE = origEnv;
  });
});
