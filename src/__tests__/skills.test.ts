import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session } from '../types';

function makeSession(overrides: Partial<Omit<Session, 'message_count'>> = {}): Omit<Session, 'message_count'> {
  return {
    id: crypto.randomBytes(20).toString('hex'),
    agent: 'claude-code',
    title: 'Test session',
    source_path: `/tmp/test-${crypto.randomBytes(4).toString('hex')}.jsonl`,
    created_at: Date.now(),
    updated_at: Date.now(),
    imported_at: Date.now(),
    ...overrides,
  };
}

describe('skills model (suggestSkills)', () => {
  let tempDir: string;

  before(() => {
    tempDir = path.join(os.tmpdir(), `box0-skills-test-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tempDir, { recursive: true });
    process.env.BOX0_DIR = tempDir;
  });

  after(() => {
    const { closeDb } = require('../lib/db');
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.BOX0_DIR;
  });

  beforeEach(() => {
    const { resetDb } = require('../lib/db');
    resetDb();
  });

  // --- Empty DB ---

  test('suggestSkills() on empty DB returns empty array', () => {
    const { suggestSkills } = require('../models/skills');
    const result = suggestSkills({});
    assert.deepStrictEqual(result, []);
  });

  // --- Single session (below default minFreq) ---

  test('suggestSkills() with single session (freq=1) returns empty array (default minFreq=2)', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Fix bug' }));
    const result = suggestSkills({});
    assert.deepStrictEqual(result, []);
  });

  test('suggestSkills({ minFreq: 1 }) with single session returns that session as high-frequency', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Fix bug' }));
    const result = suggestSkills({ minFreq: 1 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pattern, 'high-frequency');
  });

  // --- High-frequency detection ---

  test('high-frequency: 3 sessions with same title detected', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Fix login flow' }));
    insertSession(makeSession({ title: 'Fix login flow' }));
    insertSession(makeSession({ title: 'Fix login flow' }));
    const result = suggestSkills({});
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].frequency, 3);
    assert.strictEqual(result[0].pattern, 'high-frequency');
  });

  // --- High-effort detection ---

  test('high-effort: task with avg messages >= 1.5x global avg detected', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    // Create several low-msg sessions to establish baseline
    for (let i = 0; i < 4; i++) {
      const s = makeSession({ title: 'Quick task' });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // Create high-effort sessions
    const h1 = makeSession({ title: 'Debug memory leak' });
    const h2 = makeSession({ title: 'Debug memory leak' });
    insertSession(h1);
    insertSession(h2);
    incrementMessageCount(h1.id, 60);
    incrementMessageCount(h2.id, 60);
    // Baseline avg: (4*10 + 2*60) / 6 = 26.67; high-effort threshold: 40
    // Debug memory leak avg: 60 >= 40 → high-effort
    const result = suggestSkills({});
    const highEffort = result.find((r: any) => r.title === 'Debug memory leak');
    assert.ok(highEffort);
    assert.strictEqual(highEffort.pattern, 'high-effort');
  });

  // --- Cross-agent detection ---

  test('cross-agent: same task across 2 agents detected', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Write unit tests', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Write unit tests', agent: 'openclaw' }));
    const result = suggestSkills({});
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pattern, 'cross-agent');
    assert.ok(result[0].agents.includes('claude-code'));
    assert.ok(result[0].agents.includes('openclaw'));
  });

  // --- Routine detection ---

  test('routine: frequent task with low avg messages detected', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    // High-msg sessions to raise baseline
    for (let i = 0; i < 4; i++) {
      const s = makeSession({ title: 'Complex task' });
      insertSession(s);
      incrementMessageCount(s.id, 50);
    }
    // Low-msg frequent sessions
    const r1 = makeSession({ title: 'Code review' });
    const r2 = makeSession({ title: 'Code review' });
    insertSession(r1);
    insertSession(r2);
    incrementMessageCount(r1.id, 5);
    incrementMessageCount(r2.id, 5);
    // Baseline avg: (4*50 + 2*5) / 6 = 35; routine threshold: 17.5
    // Code review avg: 5 < 17.5 → routine
    const result = suggestSkills({});
    const routine = result.find((r: any) => r.title === 'Code review');
    assert.ok(routine);
    assert.strictEqual(routine.pattern, 'routine');
  });

  // --- Pattern priority ---

  test('pattern priority: cross-agent takes precedence over high-effort', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    // Create a cross-agent, high-effort task
    // Need low-msg sessions to establish baseline
    for (let i = 0; i < 4; i++) {
      const s = makeSession({ title: 'Simple task' });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // Cross-agent + high-effort
    const ca1 = makeSession({ title: 'Debug crash', agent: 'claude-code' });
    const ca2 = makeSession({ title: 'Debug crash', agent: 'openclaw' });
    insertSession(ca1);
    insertSession(ca2);
    incrementMessageCount(ca1.id, 80);
    incrementMessageCount(ca2.id, 80);
    const result = suggestSkills({});
    const crossAgent = result.find((r: any) => r.title === 'Debug crash');
    assert.ok(crossAgent);
    assert.strictEqual(crossAgent.pattern, 'cross-agent');
  });

  // --- Agent filter ---

  test('agent filter only considers that agent sessions', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Fix bug', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Fix bug', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Fix bug', agent: 'openclaw' }));
    const result = suggestSkills({ agent: 'claude-code' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].frequency, 2);
    assert.deepStrictEqual(result[0].agents, ['claude-code']);
  });

  test('agent filter disables cross-agent detection — tasks fall through to next pattern', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Write tests', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Write tests', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Write tests', agent: 'openclaw' }));
    // With agent filter, only 2 claude-code sessions, can't be cross-agent
    const result = suggestSkills({ agent: 'claude-code' });
    assert.strictEqual(result.length, 1);
    assert.notStrictEqual(result[0].pattern, 'cross-agent');
  });

  // --- Days filter ---

  test('days filter: only sessions within time window are analyzed', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    const now = Date.now();
    insertSession(makeSession({ title: 'Recent task', created_at: now }));
    insertSession(makeSession({ title: 'Recent task', created_at: now - 86400000 }));
    insertSession(makeSession({ title: 'Old task', created_at: now - 60 * 86400000 }));
    insertSession(makeSession({ title: 'Old task', created_at: now - 61 * 86400000 }));
    const result = suggestSkills({ days: 30 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, 'Recent task');
  });

  // --- Limit ---

  test('limit: suggestSkills({ limit: 2 }) returns at most 2 suggestions', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    for (let i = 0; i < 3; i++) {
      insertSession(makeSession({ title: `Task A` }));
      insertSession(makeSession({ title: `Task B` }));
      insertSession(makeSession({ title: `Task C` }));
    }
    const result = suggestSkills({ limit: 2, minFreq: 2 });
    assert.strictEqual(result.length, 2);
  });

  // --- Null titles ---

  test('null titles are excluded from analysis', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: null as any }));
    insertSession(makeSession({ title: null as any }));
    const result = suggestSkills({});
    assert.deepStrictEqual(result, []);
  });

  // --- Display title ---

  test('display title comes from most recent session in group', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    const now = Date.now();
    insertSession(makeSession({ title: 'fix bug', created_at: now - 10000 }));
    insertSession(makeSession({ title: 'Fix Bug', created_at: now }));
    const result = suggestSkills({});
    assert.strictEqual(result[0].title, 'Fix Bug');
  });

  // --- Agents array ---

  test('agents array lists all distinct agents for the task group', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Fix bug', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Fix bug', agent: 'openclaw' }));
    insertSession(makeSession({ title: 'Fix bug', agent: 'claude-code' }));
    const result = suggestSkills({});
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].agents.includes('claude-code'));
    assert.ok(result[0].agents.includes('openclaw'));
    assert.strictEqual(result[0].agents.length, 2);
  });

  // --- Sorting ---

  test('results sorted by frequency DESC, then avg messages DESC as tiebreaker', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    // 3 sessions of Task A
    for (let i = 0; i < 3; i++) {
      const s = makeSession({ title: 'Task A' });
      insertSession(s);
      incrementMessageCount(s.id, 10);
    }
    // 2 sessions of Task B (high msgs)
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Task B' });
      insertSession(s);
      incrementMessageCount(s.id, 50);
    }
    // 2 sessions of Task C (low msgs)
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Task C' });
      insertSession(s);
      incrementMessageCount(s.id, 5);
    }
    const result = suggestSkills({});
    assert.strictEqual(result[0].title, 'Task A');    // freq 3
    assert.strictEqual(result[1].title, 'Task B');     // freq 2, higher avg
    assert.strictEqual(result[2].title, 'Task C');     // freq 2, lower avg
  });

  test('sorting tiebreaker: same frequency — higher avg messages first', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Low msgs' });
      insertSession(s);
      incrementMessageCount(s.id, 5);
    }
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'High msgs' });
      insertSession(s);
      incrementMessageCount(s.id, 100);
    }
    const result = suggestSkills({});
    assert.strictEqual(result[0].title, 'High msgs');
    assert.strictEqual(result[1].title, 'Low msgs');
  });

  // --- Multiple pattern types ---

  test('multiple pattern types in one result set', () => {
    const { insertSession, incrementMessageCount } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    // Establish baseline: some medium-msg sessions
    for (let i = 0; i < 4; i++) {
      const s = makeSession({ title: 'Normal task', agent: 'claude-code' });
      insertSession(s);
      incrementMessageCount(s.id, 30);
    }
    // High-effort: high msgs
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Hard task', agent: 'claude-code' });
      insertSession(s);
      incrementMessageCount(s.id, 100);
    }
    // Routine: low msgs
    for (let i = 0; i < 2; i++) {
      const s = makeSession({ title: 'Easy task', agent: 'claude-code' });
      insertSession(s);
      incrementMessageCount(s.id, 3);
    }
    const result = suggestSkills({});
    const patterns = result.map((r: any) => r.pattern);
    assert.ok(patterns.includes('high-frequency'));
    assert.ok(patterns.includes('high-effort'));
    assert.ok(patterns.includes('routine'));
  });

  // --- Zero message_count edge case ---

  test('when all sessions have message_count=0, no high-effort or routine classification', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Task A' }));
    insertSession(makeSession({ title: 'Task A' }));
    insertSession(makeSession({ title: 'Task B' }));
    insertSession(makeSession({ title: 'Task B' }));
    const result = suggestSkills({});
    for (const r of result) {
      assert.strictEqual(r.pattern, 'high-frequency');
    }
  });

  // --- GROUP_CONCAT parsing ---

  test('GROUP_CONCAT(DISTINCT agent) result correctly parsed into AgentSource[] for multi-agent task', () => {
    const { insertSession } = require('../models/session');
    const { suggestSkills } = require('../models/skills');
    insertSession(makeSession({ title: 'Shared task', agent: 'claude-code' }));
    insertSession(makeSession({ title: 'Shared task', agent: 'openclaw' }));
    insertSession(makeSession({ title: 'Shared task', agent: 'codex' }));
    const result = suggestSkills({ minFreq: 2 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].agents.length, 3);
    assert.ok(result[0].agents.includes('claude-code'));
    assert.ok(result[0].agents.includes('openclaw'));
    assert.ok(result[0].agents.includes('codex'));
  });
});
