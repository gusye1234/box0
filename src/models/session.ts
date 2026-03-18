import { getDb } from '../lib/db';
import { Session, AgentSource } from '../types';

type SessionInput = Omit<Session, 'message_count'>;

export function insertSession(s: SessionInput): { inserted: boolean } {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, agent, title, source_path, created_at, updated_at, imported_at, message_count)
    VALUES (@id, @agent, @title, @source_path, @created_at, @updated_at, @imported_at, 0)
  `);
  const result = stmt.run(s);
  return { inserted: result.changes > 0 };
}

export function upsertSession(s: SessionInput): { inserted: boolean } {
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(s.id) !== undefined;
  db.prepare(`
    INSERT INTO sessions (id, agent, title, source_path, created_at, updated_at, imported_at, message_count)
    VALUES (@id, @agent, @title, @source_path, @created_at, @updated_at, @imported_at, 0)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      title = excluded.title,
      imported_at = excluded.imported_at
  `).run(s);
  return { inserted: !exists };
}

export function incrementMessageCount(sessionId: string, delta: number): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET message_count = message_count + ? WHERE id = ?`).run(delta, sessionId);
}

export function findById(id: string): Session | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session | undefined;
}

const COL = { updated: 'updated_at', created: 'created_at' } as const;

export function findByAgent(agent: AgentSource, limit = 100, sort: 'updated' | 'created' = 'updated'): Session[] {
  const db = getDb();
  const col = COL[sort];
  return db.prepare(`SELECT * FROM sessions WHERE agent = ? ORDER BY ${col} DESC LIMIT ?`).all(agent, limit) as Session[];
}

export function listAll(limit = 100, sort: 'updated' | 'created' = 'updated'): Session[] {
  const db = getDb();
  const col = COL[sort];
  return db.prepare(`SELECT * FROM sessions ORDER BY ${col} DESC LIMIT ?`).all(limit) as Session[];
}

export function countByAgent(agent: AgentSource): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE agent = ?`).get(agent) as { n: number };
  return row.n;
}

export function count(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
  return row.n;
}

export function existsBySourcePath(sourcePath: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT 1 FROM sessions WHERE source_path = ?`).get(sourcePath);
  return row !== undefined;
}
