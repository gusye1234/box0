import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session, Message } from '../types';
import { upsertSession } from '../models/session';
import { insertBatch } from '../models/message';
import { checkFileCache, recordFileImported } from '../lib/file-cache';

// ─── Local interfaces ────────────────────────────────────────────────────────

export interface OpenClawContentBlock {
  type: 'text' | 'thinking' | 'toolCall' | 'toolResult' | 'redacted_thinking' | string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

export interface OpenClawSessionEvent {
  type: 'session';
  id: string;
  timestamp: string;
  cwd: string;
  version: number;
}

export interface OpenClawMessageEvent {
  type: 'message';
  id: string;
  parentId: string | null;
  timestamp: string; // ISO-8601
  message: {
    role: 'user' | 'assistant';
    content: OpenClawContentBlock[];
    timestamp?: number; // Unix ms (optional)
  };
}

export interface ParsedEvents {
  sessionEvent: OpenClawSessionEvent | null;
  messageEvents: OpenClawMessageEvent[];
}

// ─── defaultBasePath ─────────────────────────────────────────────────────────

export function defaultBasePath(): string {
  const base = process.env.OPENCLAW_DIR ?? path.join(os.homedir(), '.openclaw');
  return path.join(base, 'agents', 'main', 'sessions');
}

// ─── extractText ─────────────────────────────────────────────────────────────

export function extractText(content: OpenClawContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n')
    .trim();
}

// ─── parseJSONLFile ───────────────────────────────────────────────────────────

export function parseJSONLFile(filePath: string): ParsedEvents {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  let sessionEvent: OpenClawSessionEvent | null = null;
  const messageEvents: OpenClawMessageEvent[] = [];

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

    if (obj.type === 'session' && sessionEvent === null) {
      sessionEvent = obj as unknown as OpenClawSessionEvent;
      continue;
    }

    if (obj.type === 'message') {
      const msg = obj as unknown as OpenClawMessageEvent;
      const role = msg.message?.role;
      if (role === 'user' || role === 'assistant') {
        messageEvents.push(msg);
      }
    }
  }

  return { sessionEvent, messageEvents };
}

// ─── buildSession ─────────────────────────────────────────────────────────────

export function buildSession(
  filePath: string,
  sessionEvent: OpenClawSessionEvent,
  messageEvents: OpenClawMessageEvent[]
): Session {
  const id = crypto.createHash('sha1').update(filePath).digest('hex');

  const firstUser = messageEvents.find((e) => e.message?.role === 'user');
  let title: string | null = null;
  if (firstUser) {
    const text = extractText(firstUser.message.content);
    title = text.length > 120 ? text.slice(0, 120) : text || null;
  }

  const created_at = new Date(sessionEvent.timestamp).getTime();

  // updated_at = max of outer ISO timestamp or inner Unix ms timestamp across all message events
  const timestamps: number[] = [];
  for (const ev of messageEvents) {
    if (ev.timestamp) {
      const t = new Date(ev.timestamp).getTime();
      if (!isNaN(t)) timestamps.push(t);
    }
    if (typeof ev.message?.timestamp === 'number') {
      timestamps.push(ev.message.timestamp);
    }
  }
  const updated_at = timestamps.length > 0 ? Math.max(...timestamps) : created_at;

  return {
    id,
    agent: 'openclaw',
    title,
    source_path: filePath,
    created_at,
    updated_at,
    imported_at: Date.now(),
    message_count: 0,
  };
}

// ─── importFile ───────────────────────────────────────────────────────────────

export function importFile(
  filePath: string,
  opts?: { force?: boolean }
): { inserted: boolean; messageCount: number; newMessages: number; unchanged?: boolean } {
  const cache = checkFileCache(filePath, opts?.force);
  if (cache.unchanged) {
    return { inserted: false, messageCount: 0, newMessages: 0, unchanged: true };
  }

  const { sessionEvent, messageEvents } = parseJSONLFile(cache.resolved);

  if (sessionEvent === null || messageEvents.length === 0) {
    recordFileImported(cache.resolved, cache.mtimeMs, cache.sizeBytes);
    return { inserted: false, messageCount: 0, newMessages: 0 };
  }

  const session = buildSession(cache.resolved, sessionEvent, messageEvents);
  const { inserted } = upsertSession(session);

  const messages: Message[] = messageEvents.map((ev, seq) => ({
    id: `${session.id}:${seq}`,
    session_id: session.id,
    role: ev.message.role,
    content: extractText(ev.message.content),
    seq,
    timestamp: ev.message.timestamp ?? (ev.timestamp ? new Date(ev.timestamp).getTime() : null),
  }));

  const { inserted: newMessages } = insertBatch(messages);
  recordFileImported(cache.resolved, cache.mtimeMs, cache.sizeBytes);
  return { inserted, messageCount: messages.length, newMessages };
}

// ─── extractTextFromRawMessage ────────────────────────────────────────────────

export function extractTextFromRawMessage(msg: unknown): string {
  const content = (msg as Record<string, unknown>)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as Record<string, unknown>)?.type === 'text' && typeof (b as Record<string, unknown>)?.text === 'string')
      .map((b: unknown) => (b as Record<string, unknown>).text as string)
      .join('\n\n');
  }
  return '';
}

// ─── importFromPlugin ─────────────────────────────────────────────────────────

export interface PluginImportOpts {
  sessionKey: string;
  messages: unknown[];
  workspaceDir?: string;
}

export function importFromPlugin(opts: PluginImportOpts): { upserted: boolean; inserted: number } {
  const { sessionKey, messages } = opts;
  const source_path = `openclaw://plugin/${sessionKey}`;
  const session_id = crypto.createHash('sha1').update(source_path).digest('hex');

  const firstUser = messages.find((m) => (m as Record<string, unknown>)?.role === 'user');
  let title: string | null = null;
  if (firstUser) {
    const text = extractTextFromRawMessage(firstUser);
    title = text.length > 0 ? (text.length > 120 ? text.slice(0, 120) : text) : null;
  }

  const now = Date.now();
  const sessionInput = {
    id: session_id,
    agent: 'openclaw' as const,
    title,
    source_path,
    created_at: now,
    updated_at: now,
    imported_at: now,
  };
  const { inserted } = upsertSession(sessionInput);

  const validRoles = new Set(['user', 'assistant', 'system', 'tool']);
  const msgRows: Message[] = messages.map((msg, index) => {
    const rawRole = (msg as Record<string, unknown>)?.role as string | undefined;
    const role = rawRole && validRoles.has(rawRole) ? (rawRole as Message['role']) : 'assistant';
    return {
      id: `${session_id}:${index}`,
      session_id,
      role,
      content: extractTextFromRawMessage(msg),
      seq: index,
      timestamp: null,
    };
  });

  const { inserted: insertedCount } = insertBatch(msgRows);
  return { upserted: inserted, inserted: insertedCount };
}

// ─── runImportFromPlugin ──────────────────────────────────────────────────────

export function runImportFromPlugin(opts: PluginImportOpts): { stdout: string; stderr: string; exitCode: number } {
  try {
    const { upserted, inserted } = importFromPlugin(opts);
    void upserted;
    return {
      stdout: `Synced session ${opts.sessionKey}: ${inserted} new messages.\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: (err as Error).message ?? String(err),
      exitCode: 1,
    };
  }
}

// ─── importAll ────────────────────────────────────────────────────────────────

export function importAll(
  basePath: string,
  onFile?: (filePath: string, result: { inserted: boolean; messageCount: number; unchanged?: boolean }) => void,
  opts?: { force?: boolean }
): { inserted: number; skipped: number; messages: number; unchanged: number } {
  let inserted = 0;
  let skipped = 0;
  let messages = 0;
  let unchanged = 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(basePath);
  } catch {
    return { inserted: 0, skipped: 0, messages: 0, unchanged: 0 };
  }

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    if (name.includes('.deleted.')) continue;

    const filePath = path.join(basePath, name);

    let result: ReturnType<typeof importFile>;
    try {
      result = importFile(filePath, opts);
    } catch {
      continue;
    }

    if (result.unchanged) {
      unchanged++;
    } else if (result.inserted || result.newMessages > 0) {
      inserted++;
      messages += result.newMessages;
    } else {
      skipped++;
    }

    onFile?.(filePath, result);
  }

  return { inserted, skipped, messages, unchanged };
}
