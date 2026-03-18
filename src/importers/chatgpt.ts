import * as crypto from 'crypto';
import * as fs from 'fs';
import { Session, Message } from '../types';
import { insertSession } from '../models/session';
import { insertBatch } from '../models/message';

// ─── Local interfaces ─────────────────────────────────────────────────────────

export interface ChatGPTContent {
  content_type: string;
  parts?: Array<string | null | unknown>;
  [key: string]: unknown;
}

export interface ChatGPTMessage {
  id: string;
  author: { role: 'user' | 'assistant' | 'system' | 'tool'; [key: string]: unknown };
  content: ChatGPTContent;
  create_time: number | null;
  weight: number;
  metadata: {
    is_visually_hidden_from_conversation?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

export interface ChatGPTConversation {
  id: string;
  title: string | null;
  create_time: number;
  update_time: number;
  current_node: string;
  mapping: Record<string, ChatGPTNode>;
  [key: string]: unknown;
}

// ─── defaultFilePath ──────────────────────────────────────────────────────────

export function defaultFilePath(): string {
  return process.env.CHATGPT_EXPORT_FILE ?? '';
}

// ─── extractText ─────────────────────────────────────────────────────────────

export function extractText(content: ChatGPTContent): string {
  if (content.content_type !== 'text') return '';
  if (!Array.isArray(content.parts)) return '';
  return content.parts
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}

// ─── walkMapping ─────────────────────────────────────────────────────────────

export function walkMapping(mapping: Record<string, ChatGPTNode>, currentNode: string): ChatGPTNode[] {
  // Traverse from currentNode → root collecting path, then reverse to root→leaf order
  const path: ChatGPTNode[] = [];
  let nodeId: string | null = currentNode;

  while (nodeId !== null) {
    const node: ChatGPTNode | undefined = mapping[nodeId];
    if (!node) break;
    path.push(node);
    nodeId = node.parent ?? null;
  }

  // Reverse to get root→leaf order, then filter
  const ordered = path.reverse();
  return ordered.filter((node) => {
    if (node.message === null) return false;
    const msg = node.message;
    if (msg.weight === 0) return false;
    if (msg.metadata?.is_visually_hidden_from_conversation === true) return false;
    return true;
  });
}

// ─── parseFile ───────────────────────────────────────────────────────────────

export function parseFile(filePath: string): ChatGPTConversation[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[box0] Cannot read ChatGPT export file at ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[box0] ChatGPT export file at ${filePath} contains malformed JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`[box0] ChatGPT export file at ${filePath} must be a JSON array of conversations`);
  }

  return parsed as ChatGPTConversation[];
}

// ─── buildSession ─────────────────────────────────────────────────────────────

export function buildSession(conv: ChatGPTConversation): Session {
  const id = crypto.createHash('sha1').update('chatgpt:' + conv.id).digest('hex');
  const source_path = 'chatgpt://' + conv.id;

  let title: string | null = conv.title ?? null;
  if (title && title.length > 120) title = title.slice(0, 120);
  if (title === '') title = null;

  return {
    id,
    agent: 'chatgpt',
    title,
    source_path,
    created_at: Math.round(conv.create_time * 1000),
    updated_at: Math.round(conv.update_time * 1000),
    imported_at: Date.now(),
    message_count: 0,
  };
}

// ─── importConversation ───────────────────────────────────────────────────────

export function importConversation(conv: ChatGPTConversation): { inserted: boolean; messageCount: number } {
  const nodes = walkMapping(conv.mapping, conv.current_node);

  // Only keep nodes with actual user/assistant messages that have non-empty text
  const msgNodes = nodes.filter((node) => {
    const role = node.message?.author?.role;
    return role === 'user' || role === 'assistant';
  });

  if (msgNodes.length === 0) {
    return { inserted: false, messageCount: 0 };
  }

  const session = buildSession(conv);
  const { inserted } = insertSession(session);
  if (!inserted) {
    return { inserted: false, messageCount: 0 };
  }

  const messages: Message[] = msgNodes.map((node, seq) => {
    const msg = node.message!;
    const role = msg.author.role as 'user' | 'assistant' | 'system' | 'tool';
    const content = extractText(msg.content);
    const timestamp = msg.create_time !== null ? Math.round(msg.create_time * 1000) : null;
    return {
      id: `${session.id}:${seq}`,
      session_id: session.id,
      role,
      content,
      seq,
      timestamp,
    };
  });

  insertBatch(messages);
  return { inserted: true, messageCount: messages.length };
}

// ─── importFile ───────────────────────────────────────────────────────────────

export function importFile(
  filePath: string,
  onConversation?: (conv: ChatGPTConversation, result: { inserted: boolean; messageCount: number }) => void
): { inserted: number; skipped: number; messages: number } {
  const conversations = parseFile(filePath);
  let inserted = 0;
  let skipped = 0;
  let messages = 0;

  for (const conv of conversations) {
    const result = importConversation(conv);
    if (result.inserted) {
      inserted++;
      messages += result.messageCount;
    } else {
      skipped++;
    }
    onConversation?.(conv, result);
  }

  return { inserted, skipped, messages };
}
