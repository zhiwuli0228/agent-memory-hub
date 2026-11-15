# agent-memory-hub

> **Agent memory bridge** — local-first, human-approved, file-native long-term memory for AI coding agents.
>
> One local service. Every agent shares it. Claude Code, Codex, opencode, gemini-cli, DSH — anything that speaks MCP or a shell.

## It is

- **Local-first** — your memory lives in plain Markdown files you own (`knowledge/`), versioned in `history/`, git-friendly. No cloud required. No black-box database.
- **Human-approved** — agents can *propose* memories; only you can commit them. Every stored fact is traceable: who approved it, when, and from which conversation.
- **File-native** — Markdown + YAML frontmatter + JSONL ledger. Open it, diff it, grep it, back it up with git.
- **Cross-host by design** — one MCP server + one CLI (`memhub`) + one optional local dashboard, all backed by the same files. Register once, every agent shares the same memory.
- **Scoped** — project → domain → global knowledge hierarchy with ancestor-chain search. Each agent sees exactly the layers it should.

## Status

🚧 **Under active development** (this repo was founded 2026-11-15). The stable, working edition of the same memory format is [`dsh-memory-hub`](https://www.npmjs.com/package/dsh-memory-hub) (DSH plugin, v0.8.x). `agent-memory-hub` generalizes it into a standalone cross-host service; the first stable release targets **0.1.0**.

## Design principles

Four invariants (see [AGENTS.md](AGENTS.md)):

1. Files are the authority, not a cache.
2. Humans approve; agents propose. Never self-commit.
3. Plain text only — readable, diffable, migratable.
4. Zero network by default.

Eight day-zero architecture decisions in [docs/01-architecture/decisions/ADR-0001-day-zero-principles.md](docs/01-architecture/decisions/ADR-0001-day-zero-principles.md).

## Roadmap

| Step | Deliverable |
| --- | --- |
| 1 ✅ | Repo skeleton, invariants, format contract tests |
| 2 | `core` — storage, retrieval (BM25), workspace pyramid registry |
| 3 | `transport` — MCP stdio + CLI, re-verified on four hosts |
| 4 | Approval + ledger + local dashboard (`memhub serve`) |
| 5 | Injector / extractor first-class commands (`memhub pack / hook / extract`) |

## License

MIT
