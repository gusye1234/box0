export const DB_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    PRIMARY KEY,
  agent         TEXT    NOT NULL,
  title         TEXT,
  source_path   TEXT    UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  imported_at   INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  timestamp   INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS messages_ai
  AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, session_id)
    VALUES (new.rowid, new.content, new.session_id);
  END;

CREATE TRIGGER IF NOT EXISTS messages_ad
  AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, session_id)
    VALUES ('delete', old.rowid, old.content, old.session_id);
  END;

CREATE TRIGGER IF NOT EXISTS messages_au
  AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, session_id)
    VALUES ('delete', old.rowid, old.content, old.session_id);
    INSERT INTO messages_fts(rowid, content, session_id)
    VALUES (new.rowid, new.content, new.session_id);
  END;

CREATE INDEX IF NOT EXISTS idx_sessions_agent      ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, seq);
`;
