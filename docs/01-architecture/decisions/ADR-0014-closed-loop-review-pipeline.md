# ADR-0014: Closed loop — git hub-repo as the review pipeline, Tencent memory hub as the runtime service

- Status: accepted (final topology; refines ADR-0013)
- Date: 2026-11-15
- Deciders: user (pipeline role of the git repo), AI (authored)

## Context

The team already runs Tencent's memory hub (centralized service,
uniformly administered, shared by everyone). The user asked whether the
pieces conflict: "那我的腾讯的 memory hub 岂不是白搞了，这俩不是冲突了吗".
Their resolution: reuse the Tencent service's existing capabilities and
use the previously-discussed git repo for **standardized review** —
"为了标准审核，腾讯记忆中心的数据，可以在 git 仓库中统一萃取提交……
彻底将不同人的记忆质量做一个严格把关".

## Decision

Three components, each with exactly one job:

1. **git hub-repo = the review pipeline and the authoritative source**
   of knowledge text. Contributors push personal branches
   (`memhub sync push --branch <name>`); review is the git service's
   native MR flow (human review: generalization/dedup/comments; machine
   gate: `memhub validate` as CI, non-zero exit blocks merge). Merge to
   main = final approval. The repo is the "source code" of memory;
   every entry is traceable and revertible.
2. **Tencent memory hub = the runtime retrieval service** (existing,
   reused, not rebuilt). Agents query it at run time. It is the
   published/indexed view of what main contains.
3. **memhub = the local workstation and the pipeline machinery**:
   a. local hub (personal deep memory + local cache of team knowledge);
   b. first gate — console approval (inbox approve/reject/comment)
      before anything leaves the machine;
   c. machine gate — `memhub validate` runs as CI on every MR;
   d. extraction protocol — `memhub extract material|done` for any
      workflow platform (host-agnostic by ADR-0011 §4).

Flow is **strictly one-directional**: local extraction → local approval
→ `sync push --branch` → MR review (human + validate CI) → merge to
main → publish adapter → Tencent memory hub. The publish step
(`memhub publish`) is intentionally deferred until the team settles the
Tencent hub's write API; until then, merged main is the authoritative
text and agents can consume it from the repo directly.

## Consequences

- No duplicated truth: the repo is the source, the Tencent hub is the
  published index; a one-way sync keeps them consistent.
- Quality gate is now three-layered: local approval (person), MR review
  (person), validate CI (machine) — the strict cross-person quality
  control the user asked for.
- git is no longer "an extra": it exists precisely because per-entry
  review (comments/reject/revise) is a capability the Tencent hub lacks
  (its own docs admit the governance gap).
- memhub never appears in the runtime query path — agents search the
  Tencent hub; memhub stays on the production side.
