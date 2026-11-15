# ADR-0015: Definable outbound API — `memhub publish` with a pluggable outlet

- Status: accepted
- Date: 2026-11-16
- Deciders: user ("远程服务器的部署方式，API 都是我们自己定义的……后续这个接口应该要支持定义，也有可能是我们直接通过流水线快速上线到记忆库，但是当前我们还是以腾讯的为主")

## Context

The team deploys its own memory-hub service (Tencent-style) and defines
its APIs themselves; the workflow and the API contract are still being
defined and may evolve. memhub must therefore never hardcode the remote
API. The "fast pipeline publish" idea was raised but is explicitly
shelved ("流水线这个只是我的一种假设，现在不考虑").

## Decision

1. `memhub publish [IDs...]` publishes approved entries through a
   **team-defined outlet** configured in hub.yaml (flat keys, diff-friendly):
   - `publish.adapter: http` + `publish.endpoint` + optional
     `publish.header.<Name>` headers → memhub POSTs
     `{ entries: [...], publishedAt }` to the endpoint. The request body
     shape is v1 of the built-in contract; if the team's API differs,
     use `exec` instead.
   - `publish.adapter: exec` + `publish.script` → memhub runs the team's
     own script (`node <script>`, cwd = hub root) with the entries JSON
     on stdin; exit 0 = delivered. **This is the primary path while the
     Tencent-style API evolves**: the team's script calls their API,
     and API changes only touch the script, never memhub.
   - `publish.adapter: none` (default) → publishing disabled with
     configuration guidance.
2. Payload per entry (lossless): id, version, type, title, summary,
   scope, tags, updated, sourceRefs, body.
3. Incremental semantics: bare `memhub publish` publishes everything
   updated since the last successful run (watermark
   records/publish-state.json, written only on success); explicit IDs
   publish exactly those entries without touching the watermark. Every
   successful publish appends a `publish` ledger record.
4. Publishing cadence stays manual/explicit (MR-merge then publish, or
   ad-hoc). No automatic fast-pipeline mode.

## Consequences

- memhub has zero knowledge of the Tencent memory-hub API surface; the
  team owns the contract in one place (their script or endpoint config).
- When the API settles, switching from `exec` to `http` is a two-line
  hub.yaml change.
- A failed publish reports the outlet's error and leaves the watermark
  untouched (retry-safe).
