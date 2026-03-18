import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session, Message } from '../types';
import { upsertSession } from '../models/session';
import { insertBatch } from '../models/message';

// ─── Local interfaces ─────────────────────────────────────────────────────────

export interface CodexContentBlock {
  type: string;
  text?: string;
}

export interface CodexTurnItem {
  role: 'user' | 'assistant';
  content: string | CodexContentBlock[];
  timestamp?: string | number;
  [key: string]: unknown;
}

export interface CodexThreadStarted {
  type: 'thread.started';
  session_id?: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

export interface ParsedJSONL {
  threadStarted: CodexThreadStarted | null;
  items: CodexTurnItem[];
}

// ─── defaultBasePath ──────────────────────────────────────────────────────────

export function defaultBasePath(): string {
  return process.env.CODEX_DIR ?? path.join(os.homedir(), '.codex', 'sessions');
}

// ─── extractText ─────────────────────────────────────────────────────────────

export function extractText(item: CodexTurnItem): string {
  const { content } = item;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is CodexContentBlock => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

// ─── parseJSONLFile ───────────────────────────────────────────────────────────

export function parseJSONLFile(filePath: string): ParsedJSONL {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  let threadStarted: CodexThreadStarted | null = null;
  const items: CodexTurnItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn(`[box0] warning: malformed JSON at ${filePath}:${i + 1} — skipping line`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;

    if (obj.type === 'thread.started' && threadStarted === null) {
      threadStarted = obj as unknown as CodexThreadStarted;
      continue;
    }

    // Collect events that carry role: 'user' or role: 'assistant'
    const role = obj.role as string | undefined;
    if (role === 'user' || role === 'assistant') {
      items.push(obj as unknown as CodexTurnItem);
    }
  }

  return { threadStarted, items };
}

// ─── buildSession ─────────────────────────────────────────────────────────────

export function buildSession(
  filePath: string,
  threadStarted: CodexThreadStarted | null,
  items: CodexTurnItem[]
): Session {
  const id = crypto.createHash('sha1').update(filePath).digest('hex');

  const firstUser = items.find((i) => i.role === 'user');
  let title: string | null = null;
  if (firstUser) {
    const text = extractText(firstUser);
    title = text.length > 120 ? text.slice(0, 120) : text || null;
  }

  // Collect timestamps from items
  const timestamps: number[] = [];
  for (const item of items) {
    if (item.timestamp !== undefined) {
      const t = typeof item.timestamp === 'number'
        ? item.timestamp
        : new Date(item.timestamp as string).getTime();
      if (!isNaN(t)) timestamps.push(t);
    }
  }
  // Also check threadStarted timestamp
  if (threadStarted?.timestamp !== undefined) {
    const t = typeof threadStarted.timestamp === 'number'
      ? threadStarted.timestamp
      : new Date(threadStarted.timestamp as string).getTime();
    if (!isNaN(t)) timestamps.push(t);
  }

  const now = Date.now();
  const created_at = timestamps.length > 0 ? Math.min(...timestamps) : now;
  const updated_at = timestamps.length > 0 ? Math.max(...timestamps) : now;

  return {
    id,
    agent: 'codex',
    title,
    source_path: filePath,
    created_at,
    updated_at,
    imported_at: now,
    message_count: 0,
  };
}

// ─── importFile ───────────────────────────────────────────────────────────────

export function importFile(filePath: string): { inserted: boolean; messageCount: number; newMessages: number } {
  const { threadStarted, items } = parseJSONLFile(filePath);

  if (items.length === 0) {
    return { inserted: false, messageCount: 0, newMessages: 0 };
  }

  const session = buildSession(filePath, threadStarted, items);
  const { inserted } = upsertSession(session);

  const messages: Message[] = items.map((item, seq) => {
    let timestamp: number | null = null;
    if (item.timestamp !== undefined) {
      timestamp = typeof item.timestamp === 'number'
        ? item.timestamp
        : new Date(item.timestamp as string).getTime();
      if (isNaN(timestamp)) timestamp = null;
    }
    return {
      id: `${session.id}:${seq}`,
      session_id: session.id,
      role: item.role,
      content: extractText(item),
      seq,
      timestamp,
    };
  });

  const { inserted: newMessages } = insertBatch(messages);
  return { inserted, messageCount: messages.length, newMessages };
}

// ─── importAll ────────────────────────────────────────────────────────────────

function collectRolloutFiles(dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRolloutFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
}

export function importAll(
  basePath: string,
  onFile?: (filePath: string, result: { inserted: boolean; messageCount: number }) => void
): { inserted: number; skipped: number; messages: number } {
  const files: string[] = [];
  collectRolloutFiles(basePath, files);

  let inserted = 0;
  let skipped = 0;
  let messages = 0;

  for (const filePath of files) {
    const result = importFile(filePath);
    if (result.inserted || result.newMessages > 0) {
      inserted++;
      messages += result.newMessages;
    } else {
      skipped++;
    }
    onFile?.(filePath, result);
  }

  return { inserted, skipped, messages };
}
