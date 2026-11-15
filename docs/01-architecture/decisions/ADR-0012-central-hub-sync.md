# ADR-0012: Central Hub Sync — one memhub serve as the authority

- Status: accepted (supersedes the collaboration half of ADR-0011)
- Date: 2026-11-15
- Deciders: user (challenged the git-first direction), AI (authored)

## Context

ADR-0011 mapped review/merge onto git hosting (PR/issue). The user
challenged it: "腾讯的记忆管理为啥会有 Git 管理啊" — Tencent's Team Memory
needs no git because it is a **centralized service**: one authority, all
reads/writes via API, review happens in the service's own console. Memory
entries are high-frequency small data; per-entry PRs are ceremony, git
conflicts on markdown are hostile to non-developers, and requiring a git
host (which the user's team does not standardize on) narrows adoption.

## Decision

The collaboration layer is **hub-to-hub over HTTP**, not git:

1. **Central hub** = a resident `memhub serve` on any always-on machine
   (workstation, NAS, server). It is the single source of truth: its
   `knowledge/` is authoritative, its inbox is the review queue.
2. **Local hubs push proposals**: `memhub hub push <central-url>` sends
   locally-approved entries as PROPOSALS to the central hub
   (POST /api/propose, actor `remote`). They land in the central inbox —
   **the central inbox IS the MR review**: approve = merge into the
   central knowledge base, reject (with note) = declined, note-only
   feedback = revise locally and push again. Zero new concepts; the same
   fail-closed human gate as everywhere else.
3. **Local hubs pull the authority**: `memhub hub pull <central-url>`
   fetches entries updated since the last pull (GET /api/entries?since=)
   and applies them locally (new → insert; older local version → update;
   same-or-newer local → skip). Central-approved entries are trusted and
   enter local knowledge/ directly (no second approval round).
4. **git is demoted to optional backup** (ADR-0011 remains valid only as
   `memhub sync` for disaster recovery, not as the review mechanism).
5. **Extraction protocol unchanged** (trigger-agnostic, ADR-0011 §4): the
   scheduled workflow agent may propose directly to the central hub via
   the same POST /api/propose, or to a local hub first.

## Consequences

- Multi-machine and team sharing work without git knowledge; the only
  moving part is one resident `memhub serve` process.
- Conflicts are resolved by entry version + timestamp (server-side
  serialization), never by markdown merge markers.
- The review UI already exists: the central hub's console inbox.
- Latency: central approval is required before propagation — same gate
  as before, but now it is the ONLY gate (local approval stays for
  local-only entries; pushed entries need central review).
- Security: the central hub is a LAN/service-bound HTTP endpoint; it
  accepts proposals from holders of the endpoint (token hardening can
  be layered later without changing the protocol).
