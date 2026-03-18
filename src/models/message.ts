import { getDb } from '../lib/db';
import { Message, SearchResult, AgentSource } from '../types';
import { incrementMessageCount } from './session';

export function insertBatch(messages: Message[]): { inserted: number } {
  if (messages.length === 0) return { inserted: 0 };
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, role, content, seq, timestamp)
    VALUES (@id, @session_id, @role, @content, @seq, @timestamp)
  `);

  const run = db.transaction((msgs: Message[]) => {
    // Group by session to track inserts per session
    const sessionInserts = new Map<string, number>();
    for (const msg of msgs) {
      const result = insert.run(msg);
      if (result.changes > 0) {
        sessionInserts.set(msg.session_id, (sessionInserts.get(msg.session_id) ?? 0) + 1);
      }
    }
    for (const [sessionId, delta] of sessionInserts) {
      incrementMessageCount(sessionId, delta);
    }
    return Array.from(sessionInserts.values()).reduce((a, b) => a + b, 0);
  });

  const count = run(messages);
  return { inserted: count };
}

export function findBySession(sessionId: string): Message[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`).all(sessionId) as Message[];
}

export function search(query: string, agent?: AgentSource, limit = 20): SearchResult[] {
  const db = getDb();
  const agentFilter = agent ? `AND s.agent = ?` : '';
  const params = agent ? [query, agent, limit] : [query, limit];

  const sql = `
    SELECT
      m.session_id,
      s.agent,
      snippet(messages_fts, 0, '<b>', '</b>', '…', 20) AS snippet,
      messages_fts.rank AS rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.rowid
    JOIN sessions s ON m.session_id = s.id
    WHERE messages_fts MATCH ?
    ${agentFilter}
    ORDER BY rank
    LIMIT ?
  `;

  return db.prepare(sql).all(...params) as SearchResult[];
}
