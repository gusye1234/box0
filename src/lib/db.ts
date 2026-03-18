import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DB_VERSION, SCHEMA_SQL } from './schema';

let db: Database.Database | null = null;

function getDbPath(): string {
  const box0Dir = process.env.BOX0_DIR ?? path.join(os.homedir(), '.box0');
  return path.join(box0Dir, 'box0.db');
}

function migrate(d: Database.Database): void {
  const version = Number(d.pragma('user_version', { simple: true }));

  if (version < 2) {
    d.exec(`CREATE TABLE IF NOT EXISTS file_meta (
      file_path   TEXT    PRIMARY KEY,
      mtime_ms    INTEGER NOT NULL,
      size_bytes  INTEGER NOT NULL
    )`);
  }

  if (version < DB_VERSION) {
    d.pragma(`user_version = ${DB_VERSION}`);
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb(): void {
  closeDb();
  const p = getDbPath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
  getDb();
}
