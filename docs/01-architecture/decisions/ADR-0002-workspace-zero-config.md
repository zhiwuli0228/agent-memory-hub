# ADR-0002: Workspace Zero-Config & Optional Domain Layer

## Status

Accepted (2026-11-15)

## Context

The predecessor's scope pyramid (project < domain < global) grew out of the DSH panel:
registering workspaces in `hub.yaml` is a precondition for project scope, and
`core_workspaces` / `parentCoreIds` encode a multi-project org structure. User challenge
(2026-11-15): "金字塔貌似只有 DSH 支持，其他的不支持" — for a general cross-host product,
is the pyramid a DSH-only artifact?

Survey evidence (`E:\009workspace\design-doc\长程记忆技术分析_2026.11.15.md` §4.7):
- Every host has the project/global distinction natively (project-level CLAUDE.md /
  AGENTS.md vs user-level). cwd is the one identity signal all hosts share.
- A peer plugin uses **git origin remote** as workspace identity, falling back to the
  canonical project directory — robust across subdirectories and worktrees.
- Four scope levels should be **explicit columns, not naming conventions**; scope is a
  **permission boundary**, not a retrieval optimization.
- The domain layer (a named group of projects) is an org-management concept no host
  models; requiring it up front is friction with no general-market payoff.

## Decision

1. **Workspace identity is zero-config.** Running `memhub` in any directory derives the
   workspace: `git remote get-url origin` when available, else the canonical project
   directory. First use auto-registers (name editable later in the panel/CLI).
   Registration is a management afterthought, never a precondition.
2. **Global scope exists by default** (hub-level, zero config).
3. **The domain layer is optional.** With no `domains` configured, the ancestor chain is
   `project ∪ global` — two layers, sufficient for most users. Configuring a domain
   (grouping workspaces, optional upstream chain) enables it. Existing hubs'
   `core_workspaces` / `parentCoreIds` keep working via the compatibility reader; new
   hubs don't generate them until a domain is created.
4. Scope remains a permission boundary: extraction writes only `project:<this workspace>`;
   promotion to domain/global requires a distillation proposal + human approval.
5. Identity rules unchanged (ADR-0001 principle 3): the host/entry process owns identity;
   the model may choose what to search, never who it is.

## Consequences

- Any host works with project scope on first run — zero mental overhead, isomorphic to
  the CLAUDE.md two-level mental model users already have.
- The pyramid survives as an opt-in org structure; nothing to "migrate" — old hubs read
  as-is.
- `status.workspace.exact` stays: a cwd that matches nothing falls back to a synthetic
  workspace, honestly labeled (no silent hiding of project knowledge).
- Tests: registry zero-config case; git-remote identity; domain-optional ancestor chain;
  legacy `core_workspaces` compatibility read.

## Alternatives Considered

- **Keep mandatory registration** — DSH-panel mindset; dead on arrival for `npx` users.
- **Drop the domain layer entirely** — loses the org-memory track (team-server authority
  provider, blueprint V1.0) that differentiates us; keeping it optional costs little.
