import * as fs from 'fs';
import * as path from 'path';
import { getFileMeta, upsertFileMeta } from '../models/file-meta';

export interface CacheHit {
  unchanged: true;
  resolved: string;
}

export interface CacheMiss {
  unchanged: false;
  resolved: string;
  mtimeMs: number;
  sizeBytes: number;
}

export type CacheCheckResult = CacheHit | CacheMiss;

/**
 * Checks whether a file has changed since the last import by comparing
 * mtime and size against the stored file_meta record.
 */
export function checkFileCache(filePath: string, force?: boolean): CacheCheckResult {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  const mtimeMs = Math.floor(stat.mtimeMs);
  const sizeBytes = stat.size;

  if (!force) {
    const cached = getFileMeta(resolved);
    if (cached && cached.mtime_ms === mtimeMs && cached.size_bytes === sizeBytes) {
      return { unchanged: true, resolved };
    }
  }

  return { unchanged: false, resolved, mtimeMs, sizeBytes };
}

export function recordFileImported(resolved: string, mtimeMs: number, sizeBytes: number): void {
  upsertFileMeta(resolved, mtimeMs, sizeBytes);
}
