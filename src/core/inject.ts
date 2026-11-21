import { buildIndex, isVisibleIn, search, type SearchHit } from './search.js'
import type { SearchIndex } from './search.js'
import { appendLedger, ledgerPath } from './ledger.js'
import { listEntries } from './store.js'
import { randomUUID } from 'node:crypto'

/**
 * Preflight / injection — the L0 static pack the host can paste into context
 * every turn. Denoising is top-k truncation (k<=3) + local boost (measured in
 * docs/04-development/search-replay-2026-11-15.md); min_score stays a
 * zero-relevance guard at 0. The pack targets ~250 tokens; the token estimate
 * is documented, not magic.
 */

export interface PreflightResult {
  /** ready = hits found; no_match = nothing surfaced (host injects nothing). */
  status: 'ready' | 'no_match'
  hits: Array<{ id: string; version: number; title: string; abstract: string; score: number }>
  /** Rough token estimate of the rendered pack (see estimateTokens). */
  tokens: number
  pack?: string
}

/**
 * Token estimate: CJK chars ≈ 1 token each, ASCII words ≈ 1.3. Documented
 * approximation for budget math — not a claim about any specific tokenizer.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  const asciiWords = text.split(/[^a-zA-Z0-9]+/).filter((w) => w !== '').length
  for (const char of text) {
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(char)) cjk += 1
  }
  return Math.ceil(cjk + asciiWords * 1.3)
}

/** Render the L0 pack: one line per surfaced item — [ID] title — abstract. */
export function renderPack(hits: Array<{ id: string; title: string; abstract: string }>): string {
  return hits
    .map((hit) => `[${hit.id}] ${hit.title} — ${hit.abstract}`)
    .join('\n')
}

export interface PreflightOptions {
  /** Max hits in the pack; 3 is the replay-calibrated default. */
  limit?: number
  types?: string[]
  nowIso?: () => string
}

/**
 * Run a preflight: search the current workspace scope (itself + global),
 * top-k truncated, and record a preflight.recorded event shaped like the
 * predecessor ledger (replay scripts keep working across repos).
 */
export function preflight(
  index: SearchIndex,
  hubRoot: string,
  workspaceId: string,
  intent: string,
  options?: PreflightOptions & { teamId?: string },
): PreflightResult {
  const limit = options?.limit ?? 3
  const viewer = { workspaceId, teamId: options?.teamId }
  const hits = search(index, intent, { workspaceId, teamId: options?.teamId, detail: 'L0', limit, types: options?.types })
  const surfaced = hits.map((hit) => ({
    id: hit.id,
    version: hit.version,
    title: hit.title,
    abstract: hit.abstract,
    score: hit.score,
  }))
  // KEY entries (frontmatter extra.key: true — the predecessor's "pinned
  // memory") ALWAYS ride along, intent-independent, newest first.
  // F06 gates: the same viewer visibility as the query (a key pinned in
  // ANOTHER project/team must not auto-inject here), plus status gate —
  // deprecated/withdrawn/soft-removed keys never auto-inject.
  const keyEntries = listEntries(hubRoot)
    .filter((e) =>
      e.frontmatter.extra['key'] === true &&
      !e.softRemoved &&
      e.frontmatter.status !== 'deprecated' &&
      isVisibleIn(e.frontmatter.scope, viewer),
    )
    .sort((a, b) => (b.frontmatter.updated ?? '').localeCompare(a.frontmatter.updated ?? ''))
    .slice(0, 2)
  const seenIds = new Set(surfaced.map((h) => h.id))
  for (const e of keyEntries) {
    if (seenIds.has(e.frontmatter.id)) continue
    surfaced.unshift({
      id: e.frontmatter.id,
      version: e.frontmatter.version,
      title: e.frontmatter.title,
      abstract: e.frontmatter.summary,
      score: Number.POSITIVE_INFINITY,
    })
    seenIds.add(e.frontmatter.id)
  }
  // F05: hits, pack and audit must describe the SAME version set — the pack
  // is rendered from `surfaced` (which includes pinned keys), never from the
  // raw search hits.
  const pack = surfaced.length > 0 ? renderPack(surfaced) : undefined
  const result: PreflightResult = {
    status: surfaced.length > 0 ? 'ready' : 'no_match',
    hits: surfaced,
    tokens: pack === undefined ? 0 : estimateTokens(pack),
    // Lossless-JSON contract (host tool outputs): omit absent keys instead of
    // emitting `undefined` values.
    ...(pack === undefined ? {} : { pack }),
  }
  appendLedger(ledgerPath(hubRoot), {
    type: 'preflight.recorded',
    preflightId: `PF-${randomUUID().slice(0, 8)}`,
    status: result.status,
    hits: surfaced.map((hit) => ({ id: hit.id, version: hit.version })),
    tokens: result.tokens,
    intent,
    at: options?.nowIso?.() ?? new Date().toISOString(),
  })
  return result
}

/** Rebuild an index for repeated preflights (host does this once per turn). */
export function preflightIndex(hubRoot: string, nowIso?: () => string): SearchIndex {
  return buildIndex(hubRoot, nowIso ?? (() => new Date().toISOString()))
}
