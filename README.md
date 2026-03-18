# box0

Local-first context hub that imports, indexes, and analyzes conversation history across AI coding agents. Think of it as a personal Dropbox for your agent sessions — one CLI to search, list, and gain insights from Claude Code, OpenClaw, Codex, and ChatGPT transcripts.

## Features

- **Unified import** — Batch or single-file import from Claude Code (JSONL), OpenClaw (JSONL), Codex (JSONL), and ChatGPT (JSON export)
- **Full-text search** — FTS5-powered search across all imported messages with highlighted snippets
- **Session listing** — Browse sessions filtered by agent, sorted by date, with message counts
- **Real-time sync** — Plugins/hooks for Claude Code (Stop hook), OpenClaw (plugin), and Codex (notify) that auto-import new sessions as they happen
- **Analytics** — Session statistics, activity trends, and per-agent breakdowns over configurable time windows
- **Skill suggestions** — Detects recurring task patterns (high-frequency, high-effort, cross-agent, routine) and recommends automation opportunities
- **Insight reports** — Combines stats, trends, and skill suggestions into a single overview

## Quick Start

```bash
# Install dependencies and build
npm install
npm run build

# Import sessions from all supported agents
box0 import claude-code
box0 import openclaw
box0 import codex
box0 import chatgpt --path ~/Downloads/conversations.json

# Search across all imported sessions
box0 search "database migration"
box0 search "auth" --agent claude-code --limit 20

# List recent sessions
box0 list
box0 list --agent openclaw --sort created

# Install real-time sync plugins
box0 plugin install claude-code
box0 plugin install openclaw
box0 plugin install codex
box0 plugin status

# View analytics and insights
box0 stats --days 30
box0 suggest-skills --min-freq 3
box0 insight --days 7 --json
```

Data is stored in `~/.box0/box0.db` (SQLite). Override the base directory with the `BOX0_DIR` environment variable.

## Development

```bash
# Watch mode (recompile on change)
npm run dev

# Run tests
npm test

# Clean build output
npm run clean
```

**Stack:** TypeScript (CommonJS), Node >= 20, SQLite via `better-sqlite3`, Commander for CLI, chalk@4 for colors.

**Project layout:**

```
src/
  index.ts          # CLI entry point
  types.ts          # Shared type definitions
  commands/         # CLI command handlers (import, search, list, stats, etc.)
  importers/        # Agent-specific parsers (claude-code, openclaw, codex, chatgpt)
  models/           # Database CRUD and analytics queries
  lib/              # SQLite setup, data directory, plugin installers
  __tests__/        # Tests (Node built-in test runner)
plans/              # Development plan documents per task
docs/               # Research documents (plugin/hook analysis)
```

Tests use the Node built-in test runner (`node:test`). Set `BOX0_DIR` to a temp directory for test isolation.
