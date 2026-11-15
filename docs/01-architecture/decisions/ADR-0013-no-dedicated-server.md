# ADR-0013: No Dedicated Server — local-first hubs, git as the shared center

- Status: accepted (refines ADR-0011, supersedes the topology of ADR-0012)
- Date: 2026-11-15
- Deciders: user (topology correction), AI (authored)

## Context

Three rounds of user corrections converge on one topology:

1. Local hubs live on **each user's own machine** — not a dedicated box.
2. Scheduled extraction runs **on the user's own machine too**: every user
   picks their own computer as the trigger host in the agent-workflow
   platform (multi-agent, multi-machine by design).
3. Therefore **no dedicated memory server exists**: Tencent's shape
   (deploy a central memory service, administer it centrally, everyone
   shares it) requires standing infrastructure we deliberately do not add.
4. The shared center is the **git remote the team already runs** (any
   git service; the team does not use GitHub specifically). Review/merge
   uses that service's built-in MR/PR flow and issues.

## Decision

1. **`memhub serve` is a LOCAL console only** (each user on their own
   machine: inbox, knowledge browser, audit). It is never the central
   authority and is never deployed as shared infrastructure.
2. **The center is the git remote**: `memhub sync push` publishes local
   approved knowledge; review/merge happens on the git service's MR flow
   (push to a personal branch → open MR → reviewer approves or comments →
   merge to main). `memhub sync pull` brings merged knowledge back down.
   No new servers, no new daemons — the git service already exists.
3. **ADR-0012's central-hub HTTP sync (`memhub hub push|pull`) is kept as
   an OPTIONAL path** for teams that later decide they want a resident
   authority (with its approve-in-console review). It is not the default
   topology and requires no changes to local hubs.
4. **Extraction stays trigger-agnostic** (ADR-0011 §4): each user's
   workflow agent runs `memhub extract material` on their own machine,
   distills, proposes, and the human approves locally before push.

## Consequences

- Zero standing infrastructure: laptops + the existing git service.
- Review latency matches git MR flow; single-user setups may push
  straight to main and skip MRs.
- Conflict model returns to git's: per-entry markdown files keep merge
  conflicts rare and id-addressable; `memhub validate` gates every push
  and every MR (CI on the git service).
- The hub-push/pull HTTP protocol remains code-tested and available, so
  switching topologies later is a configuration choice, not a rewrite.
