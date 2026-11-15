# ADR-0001: Day-Zero Architecture Principles

> Status: Accepted · Date: 2026-11-15
>
> Every principle below exists because the predecessor repo (`dsh-memory-hub`) built the
> opposite assumption in first and had to retrofit it. Here they are right from day one.

## Context

The predecessor grew out of a DSH plugin. Three assumptions it started with — single host,
read-only panel, single process — were all broken by reality within two months, producing
retrofits: a three-layer dependency rule, a lock lease system, a tool-conflict probe, and a
workspace resolution that still collapses to a synthetic workspace on non-DSH entries.

## Decisions

1. **Multi-host from day 0.** Two layers only: `core` (storage, retrieval, approval, ledger)
   and `transport` (MCP stdio / HTTP router / CLI). There is no `host-glue`; DSH integration
   is a future thin package outside this repo.

2. **Pyramid registry from day 0.** `workspaces` + `core_workspaces` + `parentCoreIds` are
   native core config. Every entry (MCP, CLI, future DSH) resolves workspaces through the
   same registry matching. A cwd that matches no registered root falls back to a synthetic
   workspace — documented, never silently hiding project-scoped knowledge.

3. **The host owns identity.** Workspace identity comes from the entry process's execution
   context (cwd / explicit argument). The model may choose *what* to search, never *who it
   is searching as*.

4. **Approval gates live in transport.** Write operations fail closed at the MCP/CLI layer
   without requiring any host hook. Approval surfaces are the dashboard / CLI inbox —
   identical across hosts.

5. **Injector and extractor are first-class commands.** `memhub pack`, `memhub hook`,
   `memhub extract` sit at the same level as the MCP server. Non-DSH hosts get injection and
   extraction through these, not through adaptation.

6. **Zero-dependency discipline.** Node built-ins plus a minimal allowlist (yaml/zod-class).
   No peer dependencies, no native modules. `npm i -g` installs everything.

7. **Tool surface follows the MCP spec.** Tool names, schemas, and error semantics are
   designed against the MCP directory standard; host adapters (DSH) follow, never lead.

8. **Tests are the contract.** All entries share one integration suite. One behavior, one
   test — from the first commit.

## Data compatibility

This repo reads existing hub directories directly (same `knowledge/` / `pending/` /
`history/` / `records/ledger.jsonl` layout). Both repos may point at the same hub; the
writer lock arbitrates. Format drift is prevented by cross-referenced format contract tests.

## Consequences

- No DSH types may appear in `src/` — enforced by review and a future lint rule.
- Every entry change must be mirrored in the shared test suite.
- First stable release targets 0.1.0 (npm name already reserved at 0.0.1).
