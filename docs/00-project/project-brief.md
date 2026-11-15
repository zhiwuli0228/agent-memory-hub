# Project Brief

**agent-memory-hub** is a local-first, human-approved, file-native long-term memory system for AI coding agents. Founded 2026-11-15 as the cross-host generalization of [`dsh-memory-hub`](https://www.npmjs.com/package/dsh-memory-hub) (DSH plugin, v0.8.x).

## One-liner

One local service, every agent shares it — Claude Code, Codex, opencode, gemini-cli, DSH.

## Position (five cards nobody else holds)

1. **File-native** — the only memory system that treats memory as code (Markdown + git + versioned history).
2. **Human-approved + traceable ledger** — nobody in the industry does human approval (Letta documents "does not ask you for approval"); we make every fact auditable.
3. **Complete scope governance** — hierarchy + ancestor-chain + ascend-only-by-distillation + forget propagation + orphan ledger (a 2026 survey found 2 of 13 host contracts declare scope, 1 declares forget).
4. **DSH production contract, fully implemented** — the only complete implementation of the six-point memory production contract documented by the DSH upstream analysis.
5. **One service, every entry** — MCP + CLI + dashboard verified on four hosts (V30–V33 in the predecessor's COMPATIBILITY.md).

## Primary use case

In-company deployment first (zero-explanation naming, one-command install, intranet-safe), public npm release maintained alongside.

## Relationship to dsh-memory-hub

- Same hub directory format, zero migration; both repos can point at the same hub.
- `dsh-memory-hub` stays the DSH-plugin edition; this repo is the standalone cross-host service.
