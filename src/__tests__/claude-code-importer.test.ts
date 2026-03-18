import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `box0-importer-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a JSONL fixture file.  entries can be partial raw objects. */
function writeJSONL(filePath: string, entries: object[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function makeEntry(role: 'user' | 'assistant', content: string | object[], timestamp = '2024-01-01T00:00:00.000Z') {
  return {
    type: role,
    uuid: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    timestamp,
    message: { role, content },
  };
}

// ─── tests for extractText ───────────────────────────────────────────────────

describe('extractText', () => {
  test('plain string content returns string as-is', () => {
    const { extractText } = require('../importers/claude-code');
    assert.strictEqual(extractText('hello world'), 'hello world');
  });

  test('ContentBlock[] joins only type:text blocks', () => {
    const { extractText } = require('../importers/claude-code');
    const blocks = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
      { type: 'text', text: 'World' },
      { type: 'tool_result', content: 'ok' },
      { type: 'thinking', thinking: 'hmm' },
    ];
    assert.strictEqual(extractText(blocks), 'Hello\n\nWorld');
  });

  test('empty array returns empty string', () => {
    const { extractText } = require('../importers/claude-code');
    assert.strictEqual(extractText([]), '');
  });
});

// ─── tests for parseJSONLFile ─────────────────────────────────────────────────

describe('parseJSONLFile', () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('filters out queue-operation and last-prompt entries', () => {
    const { parseJSONLFile } = require('../importers/claude-code');
    const filePath = path.join(tmpDir, 'filter.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'hello'),
      { type: 'queue-operation', uuid: 'x', message: { role: 'user', content: 'skip' } },
      { type: 'last-prompt', uuid: 'y', message: { role: 'user', content: 'skip' } },
      makeEntry('assistant', 'hi'),
    ]);
    const entries = parseJSONLFile(filePath);
    assert.strictEqual(entries.length, 2);
    assert.ok(entries.every((e: { type: string }) => e.type === 'user' || e.type === 'assistant'));
  });

  test('skips malformed JSON lines without throwing', () => {
    const { parseJSONLFile } = require('../importers/claude-code');
    const filePath = path.join(tmpDir, 'malformed.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(makeEntry('user', 'valid')),
        'THIS IS NOT JSON {{{',
        JSON.stringify(makeEntry('assistant', 'also valid')),
      ].join('\n') + '\n',
      'utf8'
    );
    const entries = parseJSONLFile(filePath);
    assert.strictEqual(entries.length, 2);
  });

  test('returns entries in file order', () => {
    const { parseJSONLFile } = require('../importers/claude-code');
    const filePath = path.join(tmpDir, 'order.jsonl');
    const e1 = makeEntry('user', 'first', '2024-01-01T00:00:00.000Z');
    const e2 = makeEntry('assistant', 'second', '2024-01-01T00:01:00.000Z');
    const e3 = makeEntry('user', 'third', '2024-01-01T00:02:00.000Z');
    writeJSONL(filePath, [e1, e2, e3]);
    const entries = parseJSONLFile(filePath);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(extractText(entries[0].message.content), 'first');
    assert.strictEqual(extractText(entries[1].message.content), 'second');
    assert.strictEqual(extractText(entries[2].message.content), 'third');

    function extractText(c: unknown) {
      const { extractText: et } = require('../importers/claude-code');
      return et(c);
    }
  });
});

// ─── tests for buildSession ────────────────────────────────────────────────────

describe('buildSession', () => {
  let tmpDir: string;

  before(() => { tmpDir = makeTempDir(); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('title truncated to 120 chars when first message is long', () => {
    const { buildSession } = require('../importers/claude-code');
    const longText = 'a'.repeat(200);
    const entries = [makeEntry('user', longText, '2024-01-01T00:00:00.000Z')];
    const session = buildSession('/tmp/fake.jsonl', entries);
    assert.ok(session.title !== null);
    assert.ok((session.title as string).length <= 120);
  });

  test('id is deterministic SHA-1 of source_path', () => {
    const { buildSession } = require('../importers/claude-code');
    const filePath = '/tmp/deterministictest.jsonl';
    const entries = [makeEntry('user', 'hi', '2024-01-01T00:00:00.000Z')];
    const s1 = buildSession(filePath, entries);
    const s2 = buildSession(filePath, entries);
    assert.strictEqual(s1.id, s2.id);
    const expected = crypto.createHash('sha1').update(filePath).digest('hex');
    assert.strictEqual(s1.id, expected);
  });

  test('created_at is min timestamp, updated_at is max timestamp', () => {
    const { buildSession } = require('../importers/claude-code');
    const entries = [
      makeEntry('user', 'msg1', '2024-01-01T00:00:00.000Z'),
      makeEntry('assistant', 'msg2', '2024-01-01T00:05:00.000Z'),
      makeEntry('user', 'msg3', '2024-01-01T00:03:00.000Z'),
    ];
    const session = buildSession('/tmp/timestamps.jsonl', entries);
    assert.strictEqual(session.created_at, new Date('2024-01-01T00:00:00.000Z').getTime());
    assert.strictEqual(session.updated_at, new Date('2024-01-01T00:05:00.000Z').getTime());
  });
});

// ─── DB-touching tests for importFile / importAll ────────────────────────────

describe('importFile', () => {
  let box0Dir: string;
  let claudeDir: string;

  before(() => {
    box0Dir = makeTempDir();
    claudeDir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
    process.env.CLAUDE_DIR = claudeDir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
    delete process.env.CLAUDE_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  test('importFile inserts session + messages for valid JSONL', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'test.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'hello', '2024-01-01T00:00:00.000Z'),
      makeEntry('assistant', 'hi there', '2024-01-01T00:01:00.000Z'),
    ]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, true);
    assert.strictEqual(result.messageCount, 2);
  });

  test('importFile on second call returns unchanged (file cache hit)', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'dedup.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'first call', '2024-01-01T00:00:00.000Z'),
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(first.messageCount, 1);
    const second = importFile(filePath);
    assert.strictEqual(second.unchanged, true);
  });

  test('importFile with force:true on second call upserts and reports 0 new messages', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'force-dedup.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'force test', '2024-01-01T00:00:00.000Z'),
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(first.messageCount, 1);
    const second = importFile(filePath, { force: true });
    assert.strictEqual(second.inserted, false);
    assert.strictEqual(second.messageCount, 1);
    assert.strictEqual(second.newMessages, 0);
    assert.ok(!second.unchanged);
  });

  test('importFile: changed mtime triggers full re-import', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'mtime-change.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'mtime test', '2024-01-01T00:00:00.000Z'),
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.inserted, true);

    // Touch the file to change mtime (rewrite same content)
    const content = fs.readFileSync(filePath, 'utf8');
    const futureTime = Date.now() + 10000;
    fs.utimesSync(filePath, futureTime / 1000, futureTime / 1000);

    const second = importFile(filePath);
    assert.ok(!second.unchanged, 'Should re-import after mtime change');
    assert.strictEqual(second.inserted, false);
    assert.strictEqual(second.newMessages, 0);
  });

  test('importFile: changed size triggers full re-import', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'size-change.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'size test', '2024-01-01T00:00:00.000Z'),
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.inserted, true);

    // Append content to change size
    fs.appendFileSync(filePath, JSON.stringify(makeEntry('assistant', 'reply', '2024-01-01T00:01:00.000Z')) + '\n');
    const second = importFile(filePath);
    assert.ok(!second.unchanged, 'Should re-import after size change');
    assert.strictEqual(second.newMessages, 1);
  });

  test('importFile: file_meta is updated after successful import', () => {
    const { importFile } = require('../importers/claude-code');
    const { getFileMeta } = require('../models/file-meta');
    const filePath = path.join(claudeDir, 'meta-update.jsonl');
    writeJSONL(filePath, [
      makeEntry('user', 'meta test', '2024-01-01T00:00:00.000Z'),
    ]);
    importFile(filePath);
    const absPath = path.resolve(filePath);
    const meta = getFileMeta(absPath);
    assert.ok(meta !== undefined, 'file_meta should be set after import');
    const stat = fs.statSync(absPath);
    assert.strictEqual(meta!.mtime_ms, Math.floor(stat.mtimeMs));
    assert.strictEqual(meta!.size_bytes, stat.size);
  });

  test('importFile: empty file (0 entries) is cached after import; second run skips', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'empty-cached.jsonl');
    writeJSONL(filePath, [
      { type: 'queue-operation', uuid: 'x', message: { role: 'user', content: 'skip' } },
    ]);
    const first = importFile(filePath);
    assert.strictEqual(first.messageCount, 0);
    assert.ok(!first.unchanged);

    const second = importFile(filePath);
    assert.strictEqual(second.unchanged, true);
  });

  test('importFile handles JSONL with zero user/assistant entries', () => {
    const { importFile } = require('../importers/claude-code');
    const filePath = path.join(claudeDir, 'empty.jsonl');
    writeJSONL(filePath, [
      { type: 'queue-operation', uuid: 'x', message: { role: 'user', content: 'skip' } },
    ]);
    const result = importFile(filePath);
    assert.strictEqual(result.inserted, false);
    assert.strictEqual(result.messageCount, 0);

    // ensure no DB rows were written
    const { count } = require('../models/session');
    assert.strictEqual(count(), 0);
  });
});

describe('importAll', () => {
  let box0Dir: string;
  let claudeDir: string;

  before(() => {
    box0Dir = makeTempDir();
    claudeDir = makeTempDir();
    process.env.BOX0_DIR = box0Dir;
    process.env.CLAUDE_DIR = claudeDir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(box0Dir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
    delete process.env.CLAUDE_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
    // Clear claudeDir filesystem so each test starts with a clean slate
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  test('correctly counts sessions and messages across multiple fixture files', () => {
    const { importAll } = require('../importers/claude-code');

    // project1 has 2 JSONL files
    const proj1 = path.join(claudeDir, '-home-user--proj1');
    fs.mkdirSync(proj1);
    writeJSONL(path.join(proj1, 'a.jsonl'), [
      makeEntry('user', 'q1'),
      makeEntry('assistant', 'a1'),
    ]);
    writeJSONL(path.join(proj1, 'b.jsonl'), [
      makeEntry('user', 'q2'),
    ]);

    // project2 has 1 JSONL file
    const proj2 = path.join(claudeDir, '-home-user--proj2');
    fs.mkdirSync(proj2);
    writeJSONL(path.join(proj2, 'c.jsonl'), [
      makeEntry('user', 'q3'),
      makeEntry('assistant', 'a3'),
      makeEntry('user', 'q4'),
    ]);

    const result = importAll(claudeDir);
    assert.strictEqual(result.sessions, 3);   // 3 JSONL files total
    assert.strictEqual(result.inserted, 3);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.messages, 6);   // 2 + 1 + 3
  });

  test('skips subdirectories inside project dirs (memory/, UUID-named dirs)', () => {
    const { importAll } = require('../importers/claude-code');

    const proj = path.join(claudeDir, '-home-user--proj-skip');
    fs.mkdirSync(proj);

    // valid JSONL file
    writeJSONL(path.join(proj, 'real.jsonl'), [makeEntry('user', 'hello')]);

    // memory/ subdir — should be skipped
    const memDir = path.join(proj, 'memory');
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memory');

    // UUID-named subdir (same name as a jsonl) — should be skipped
    const uuidSubdir = path.join(proj, 'fake-uuid');
    fs.mkdirSync(uuidSubdir);
    writeJSONL(path.join(uuidSubdir, 'agent-0.jsonl'), [makeEntry('user', 'subagent msg')]);

    const result = importAll(claudeDir);
    assert.strictEqual(result.sessions, 1);   // only real.jsonl
    assert.strictEqual(result.inserted, 1);
    assert.strictEqual(result.messages, 1);
  });

  test('does not recurse into UUID-named subdirs coexisting with same-named .jsonl', () => {
    const { importAll } = require('../importers/claude-code');

    const proj = path.join(claudeDir, '-home-user--proj-coexist');
    fs.mkdirSync(proj);

    // a.jsonl file
    writeJSONL(path.join(proj, 'abc123.jsonl'), [makeEntry('user', 'main msg')]);

    // sibling dir named abc123 (same UUID, no extension)
    const siblingDir = path.join(proj, 'abc123');
    fs.mkdirSync(siblingDir);
    const subagentsDir = path.join(siblingDir, 'subagents');
    fs.mkdirSync(subagentsDir);
    writeJSONL(path.join(subagentsDir, 'agent-0.jsonl'), [makeEntry('user', 'sub msg')]);

    const result = importAll(claudeDir);
    assert.strictEqual(result.sessions, 1);   // only abc123.jsonl
    assert.strictEqual(result.inserted, 1);
    assert.strictEqual(result.messages, 1);
  });

  test('file deleted between readdir and processing (bulk import) is skipped without crash', () => {
    const { importAll } = require('../importers/claude-code');

    const proj = path.join(claudeDir, '-home-user--proj-deleted');
    fs.mkdirSync(proj);
    writeJSONL(path.join(proj, 'kept.jsonl'), [makeEntry('user', 'kept')]);
    const ephemeralPath = path.join(proj, 'ephemeral.jsonl');
    writeJSONL(ephemeralPath, [makeEntry('user', 'vanishing')]);

    // Delete the file right after creation to simulate race condition
    fs.unlinkSync(ephemeralPath);

    const result = importAll(claudeDir);
    assert.strictEqual(result.inserted, 1);
  });

  test('defaultBasePath returns CLAUDE_DIR env when set', () => {
    const { defaultBasePath } = require('../importers/claude-code');
    assert.strictEqual(defaultBasePath(), claudeDir);
  });

  test('defaultBasePath returns ~/.claude/projects when CLAUDE_DIR not set', () => {
    const origClaudeDir = process.env.CLAUDE_DIR;
    delete process.env.CLAUDE_DIR;
    const { defaultBasePath } = require('../importers/claude-code');
    const expected = path.join(os.homedir(), '.claude', 'projects');
    assert.strictEqual(defaultBasePath(), expected);
    if (origClaudeDir !== undefined) {
      process.env.CLAUDE_DIR = origClaudeDir;
    }
  });
});
