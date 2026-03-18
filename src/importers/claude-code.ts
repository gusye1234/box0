import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session, Message, ImportStats } from '../types';
import { upsertSession } from '../models/session';
import { insertBatch } from '../models/message';

interface ContentBlock {
  type: string;
  text?: string;
}

interface RawEntry {
  type: 'user' | 'assistant';
  uuid: string;
  sessionId?: string;
  timestamp?: string;
  message: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
  };
}

export function defaultBasePath(): string {
  return process.env.CLAUDE_DIR ?? path.join(os.homedir(), '.claude', 'projects');
}

export function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n')
    .trim();
}

export function parseJSONLFile(filePath: string): RawEntry[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const entries: RawEntry[] = [];
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
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    entries.push(obj as unknown as RawEntry);
  }
  return entries;
}

export function buildSession(filePath: string, entries: RawEntry[]): Session {
  const id = crypto.createHash('sha1').update(filePath).digest('hex');

  const firstUser = entries.find(
    (e) => e.message?.role === 'user' || e.type === 'user'
  );
  let title: string | null = null;
  if (firstUser) {
    const text = extractText(firstUser.message.content);
    title = text.length > 120 ? text.slice(0, 120) : text || null;
  }

  const timestamps = entries
    .filter((e) => e.timestamp)
    .map((e) => new Date(e.timestamp!).getTime())
    .filter((t) => !isNaN(t));

  const now = Date.now();
  const created_at = timestamps.length > 0 ? Math.min(...timestamps) : now;
  const updated_at = timestamps.length > 0 ? Math.max(...timestamps) : now;

  return {
    id,
    agent: 'claude-code',
    title,
    source_path: filePath,
    created_at,
    updated_at,
    imported_at: now,
    message_count: 0,
  };
}

export function importFile(filePath: string): { inserted: boolean; messageCount: number; newMessages: number } {
  const entries = parseJSONLFile(filePath);
  if (entries.length === 0) {
    return { inserted: false, messageCount: 0, newMessages: 0 };
  }

  const session = buildSession(filePath, entries);
  const { inserted } = upsertSession(session);

  const messages: Message[] = entries.map((entry, seq) => ({
    id: `${session.id}:${seq}`,
    session_id: session.id,
    role: entry.message.role,
    content: extractText(entry.message.content),
    seq,
    timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : null,
  }));

  const { inserted: newMessages } = insertBatch(messages);
  return { inserted, messageCount: messages.length, newMessages };
}

export interface ProjectProgress {
  projName: string;
  files: number;
  inserted: number;
  skipped: number;
}

export interface ImportAllResult extends ImportStats {
  sessions: number;
  messages: number;
}

export function importAll(
  basePath: string,
  onProject?: (p: ProjectProgress) => void
): ImportAllResult {
  let sessions = 0;
  let messages = 0;
  let inserted = 0;
  let skipped = 0;

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(basePath);
  } catch {
    return { sessions, messages, inserted, skipped };
  }

  for (const projName of projectDirs) {
    const projPath = path.join(basePath, projName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(projPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = fs.readdirSync(projPath);
    } catch {
      continue;
    }

    let projFiles = 0;
    let projInserted = 0;
    let projSkipped = 0;

    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue;
      const filePath = path.join(projPath, fileName);
      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) continue;

      projFiles++;
      sessions++;
      const result = importFile(filePath);
      if (result.inserted || result.newMessages > 0) {
        projInserted++;
        inserted++;
        messages += result.newMessages;
      } else {
        projSkipped++;
        skipped++;
      }
    }

    if (projFiles > 0) {
      onProject?.({ projName, files: projFiles, inserted: projInserted, skipped: projSkipped });
    }
  }

  return { sessions, messages, inserted, skipped };
}
