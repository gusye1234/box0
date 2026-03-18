export type AgentSource = 'claude-code' | 'openclaw' | 'codex' | 'chatgpt';

export interface Session {
  id: string;           // SHA-1 of source_path
  agent: AgentSource;
  title: string | null;
  source_path: string;  // absolute path, unique
  created_at: number;   // Unix ms
  updated_at: number;   // Unix ms
  imported_at: number;  // Unix ms
  message_count: number;
}

export interface Message {
  id: string;           // `${session_id}:${seq}`
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  seq: number;          // 0-based within session
  timestamp: number | null;
}

export interface SearchResult {
  session_id: string;
  agent: AgentSource;
  snippet: string;      // FTS5 snippet() highlighted text with <b>…</b> tags
  rank: number;         // FTS5 rank (negative; lower = more relevant)
}

export interface ImportStats {
  inserted: number;
  skipped: number;
}
