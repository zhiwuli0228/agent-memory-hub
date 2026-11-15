# ADR-0011: Git-First Memory Sync — the hub IS a repository

- Status: accepted
- Date: 2026-11-15
- Deciders: user (raised the remote-repository question), AI (authored)

## Context

User need (2026-11-15): memories should flow from local hubs to a central
repository after approval or scheduled/manual extraction; extraction should
be schedulable and validated before submission; the remote may reject or
accept contributions; and there should be an MR/issue-like feedback loop so
reviewers can comment, authors revise, and only then entries merge.

Tencent's Team Memory (TencentDB Agent Memory 2.0) was evaluated as the
reference point: it is a centralized API service (Team/Agent/Task tuple,
cloud storage, proxy injection, background L1→L2→L3 extraction). Its own
documentation (techpedia 148654, §6.2) states team memory "is more like a
code repository: it needs versions, branches, permissions, review, merging,
and rollback" — but the product ships only ACL boundaries and confidence
tiers; there is **no MR/PR-style review-merge workflow and no issue-style
feedback channel for memory entries** (independent coverage reached the same
conclusion: "no governance yet for when it's wrong").

## Decision

Do not build a bespoke central server. **Treat the hub root as a git
repository and delegate sync + review + issue to git hosting (GitHub/GitLab)
infrastructure.**

1. **Sync layer (memhub CLI)**: `memhub sync status|init|push|pull` wrap git.
   The hub root's `knowledge/`, `history/`, `records/` (ledger + journal)
   are committed; `pending/` stays local (proposals are a local queue).
2. **Review/merge (remote)**: contributions land as a **branch + Pull
   Request**. Rejection = PR declined (entry never merges). Feedback =
   PR comments; the author revises locally (panel edit or supersedes
   proposal) and pushes again. Issues cover longer-lived concerns about
   entries (deprecation requests, applicability disputes).
3. **Extraction validation (memhub validate)**: contract checks over
   pending + knowledge (frontmatter parses, ids unique, no title conflicts,
   scopes well-formed). Runs locally before push and as CI on every PR —
   a red check blocks merge, i.e. "validated before it can merge".
4. **Scheduled extraction — trigger-agnostic (revised 2026-11-15 after user
   feedback)**: extraction is scheduled by ANY workflow tool the user already
   runs (agent-workflow platforms, cron, Task Scheduler, CI). memhub exposes
   a CLI protocol, never a host-specific scheduler binding — tying it to one
   host (e.g. DSH schedules) would lock out every other host's users:
   - `memhub extract material [--since]` emits what changed since the last
     watermark (ledger events + current entries + pending titles) as JSON
     for the platform's agent to consume.
   - the agent distills/generalizes and writes with `memhub propose`
     (supersedes for re-extraction).
   - `memhub extract done` advances the watermark (records/extract-state.json).
   - `memhub validate` then `memhub sync push` close the loop.
   The workflow platform supplies the model; memhub supplies the material,
   the guardrails, and the write path.

## Consequences

- Zero new server infrastructure; zero new dependencies (git is an
  external tool invoked by the CLI transport, never imported by core).
- The fail-closed approval chain is unchanged: local pending → human
  approve → knowledge/ → push → remote PR → review → merge.
- Multi-machine use becomes: clone the hub repo, point `MEMHUB_ROOT`
  at it, work, `sync push`. Conflicts surface as ordinary git merge
  conflicts on per-entry markdown files (id-addressable, low collision).
- Tencent's gap (no review-merge feedback loop) becomes our differentiator:
  we inherit the ecosystem's review tooling instead of rebuilding it.
- Constraint: remote review adds latency to propagation (PR merge needed).
  Single-user multi-machine setups may push straight to main and skip PRs.
