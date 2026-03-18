import * as path from 'path';
import { getDb } from '../lib/db';

export interface FileMeta {
  file_path: string;
  mtime_ms: number;
  size_bytes: number;
}

export function getFileMeta(filePath: string): { mtime_ms: number; size_bytes: number } | undefined {
  const db = getDb();
  const resolved = path.resolve(filePath);
  const row = db.prepare(`SELECT mtime_ms, size_bytes FROM file_meta WHERE file_path = ?`).get(resolved) as
    | { mtime_ms: number; size_bytes: number }
    | undefined;
  return row;
}

export function upsertFileMeta(filePath: string, mtime_ms: number, size_bytes: number): void {
  const db = getDb();
  const resolved = path.resolve(filePath);
  db.prepare(`
    INSERT INTO file_meta (file_path, mtime_ms, size_bytes)
    VALUES (?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes
  `).run(resolved, mtime_ms, size_bytes);
}
