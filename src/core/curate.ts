import { listEntries, listProposals, type KnowledgeEntry } from './store.js'
import { tokenize } from './search.js'
import { nowIso } from './time.js'

/**
 * ADR-0017: curation analysis for scheduled extraction runs.
 *
 * Extraction turns scattered material into proposals; curation decides how
 * those proposals relate to the knowledge already approved:
 *
 *   duplicate  — near-identical to an approved entry (Jaccard >= 0.75):
 *                approve WITH supersedes so the entry version-bumps instead
 *                of forking into a twin.
 *   merge      — same type, 0.45..0.75 overlap, proposal-vs-entry or
 *                proposal-vs-proposal: candidate for one merged entry.
 *   aging      — the approved entry is aging against this proposal: a
 *                decision/constraint the proposal touches (semantic conflict
 *                candidate), an entry not verified for `agingDays`, or an
 *                entry whose expiresAt is approaching.
 *   fresh      — nothing similar: a genuinely new topic.
 *
 * This module is PURE ANALYSIS: it never lands, merges, or deprecates
 * anything by itself. Every recommendation is a grouped report for the
 * human gate (panel / `memhub inbox approve`), optionally with supersedes
 * wired at approval time.
 */

export type CurateKind = 'duplicate' | 'merge' | 'aging' | 'fresh'

export interface CurateRow {
  kind: CurateKind
  proposalId?: string
  knowledgeId?: string
  title: string
  similarity?: number
  reason: string
  suggestedAction: string
}

export interface CurateReport {
  generatedAt: string
  duplicateThreshold: number
  mergeThreshold: number
  agingDays: number
  proposalsAnalyzed: number
  entriesAnalyzed: number
  duplicates: CurateRow[]
  merges: CurateRow[]
  aging: CurateRow[]
  fresh: CurateRow[]
}

export interface CurateOptions {
  duplicateThreshold?: number
  mergeThreshold?: number
  /** Entries whose `updated`/`created` is older than this many days become aging review candidates. Default 90. */
  agingDays?: number
  /** Entries expiring within this many days become aging review candidates. Default 30. */
  expiringDays?: number
}

const AGING_TYPES = new Set(['decision', 'constraint', 'knowledge', 'api-catalog', 'process'])

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

function entryTokens(entry: KnowledgeEntry): Set<string> {
  const fm = entry.frontmatter
  const text = `${fm.title} ${fm.summary} ${(fm.tags ?? []).join(' ')} ${entry.body.slice(0, 400)}`
  return new Set(tokenize(text))
}

function proposalTokens(p: { frontmatter: { title: string; summary: string; tags?: string[] }; body?: string }): Set<string> {
  const text = `${p.frontmatter.title} ${p.frontmatter.summary} ${(p.frontmatter.tags ?? []).join(' ')} ${(p.body ?? '').slice(0, 400)}`
  return new Set(tokenize(text))
}

function daysSince(iso: string | undefined, now: number): number {
  if (iso === undefined) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return Math.floor((now - t) / 86_400_000)
}

/** Analyze every pending proposal against the approved corpus. Pure read. */
export function analyzeCurate(root: string, options: CurateOptions = {}): CurateReport {
  // Calibrated against CJK-bigram jaccard on real hub pairs: verbatim-ish
  // twins land ~0.74, same-topic rewordings ~0.38, unrelated pairs <0.1.
  const duplicateThreshold = options.duplicateThreshold ?? 0.72
  const mergeThreshold = options.mergeThreshold ?? 0.32
  const agingDays = options.agingDays ?? 90
  const expiringDays = options.expiringDays ?? 30
  const now = Date.now()

  const proposals = listProposals(root)
  const entries = listEntries(root).filter((e) => !e.softRemoved)
  const entryTokenCache = entries.map((e) => ({ entry: e, tokens: entryTokens(e) }))

  const duplicates: CurateRow[] = []
  const merges: CurateRow[] = []
  const aging: CurateRow[] = []
  const fresh: CurateRow[] = []

  // ── Pass 1: entry-level aging review — runs REGARDLESS of proposals.
  // (Stale/expiring knowledge needs review even in a quiet week.)
  const agingSeen = new Set<string>()
  const pushAging = (row: CurateRow, key: string): void => {
    if (agingSeen.has(key)) return
    agingSeen.add(key)
    aging.push(row)
  }
  for (const { entry } of entryTokenCache) {
    const fm = entry.frontmatter
    if (!AGING_TYPES.has(fm.type)) continue
    const staleDays = daysSince(fm.updated ?? fm.created, now)
    if (staleDays > agingDays) {
      pushAging({
        kind: 'aging',
        knowledgeId: fm.id,
        title: `${fm.title} (v${fm.version})`,
        reason: `${fm.type} 已 ${Number.isFinite(staleDays) ? staleDays : '—'} 天未验证（last_verified: ${fm.last_verified ?? '从未'}）`,
        suggestedAction: '复审：仍然正确则 touch last_verified；过时则 deprecate 或发 supersedes 提案',
      }, `stale:${fm.id}`)
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs - now < expiringDays * 86_400_000) {
      pushAging({
        kind: 'aging',
        knowledgeId: fm.id,
        title: `${fm.title} (v${fm.version})`,
        reason: `expiresAt 将在 ${Math.max(0, Math.ceil((entry.expiresAtMs - now) / 86_400_000))} 天内到期`,
        suggestedAction: '复审：续期（更新 expiresAt）或让它自然过期',
      }, `expiry:${fm.id}`)
    }
  }

  // ── Pass 2: proposals × approved entries — dedupe, merge, semantic conflict.
  const matchedProposals = new Set<string>()
  for (const proposal of proposals) {
    const pTokens = proposalTokens(proposal)

    for (const { entry, tokens } of entryTokenCache) {
      const sim = jaccard(pTokens, tokens)
      const fm = entry.frontmatter
      if (sim >= duplicateThreshold) {
        matchedProposals.add(proposal.id)
        duplicates.push({
          kind: 'duplicate',
          proposalId: proposal.id,
          knowledgeId: fm.id,
          title: `${proposal.frontmatter.title} ⇄ ${fm.title} (v${fm.version})`,
          similarity: Math.round(sim * 1000) / 1000,
          reason: `与已入库条目 ${fm.id} 相似度 ${(sim * 100).toFixed(0)}%`,
          suggestedAction: `批准时携带 supersedes: ${fm.id} —— 该条目版本升级而非分叉出孪生条目`,
        })
        continue
      }
      if (sim >= mergeThreshold && proposal.frontmatter.type === fm.type) {
        matchedProposals.add(proposal.id)
        merges.push({
          kind: 'merge',
          proposalId: proposal.id,
          knowledgeId: fm.id,
          title: `${proposal.frontmatter.title} + ${fm.title} (v${fm.version})`,
          similarity: Math.round(sim * 1000) / 1000,
          reason: `同类型（${fm.type}）、相似度 ${(sim * 100).toFixed(0)}% —— 内容互补可合并`,
          suggestedAction: `人工确认后二选一：批准提案并 supersedes ${fm.id}，或编辑提案为合并稿再批`,
        })
      }
      // Semantic-conflict aging: an approved decision/constraint the proposal
      // meaningfully overlaps but does not duplicate — the new wording may
      // supersede the old ruling. One row per entry (first proposal wins).
      if (AGING_TYPES.has(fm.type) && sim >= 0.5) {
        pushAging({
          kind: 'aging',
          proposalId: proposal.id,
          knowledgeId: fm.id,
          title: `${fm.title} (v${fm.version})`,
          similarity: Math.round(sim * 1000) / 1000,
          reason: `新提案 ${proposal.id} 与本条 ${fm.type} 同域重叠 ${(sim * 100).toFixed(0)}% —— 结论可能已被更新`,
          suggestedAction: `批准新提案时决定旧条命运：supersedes ${fm.id}（升级）或单独 deprecate`,
        }, `conflict:${fm.id}`)
      }
    }
  }

  // ── Pass 3: proposal-vs-proposal redundancy — extraction runs often emit
  // near-identical proposals; surface the twins before a human sees both.
  for (let i = 0; i < proposals.length; i += 1) {
    const a = proposals[i]
    if (a === undefined) continue
    for (let j = i + 1; j < proposals.length; j += 1) {
      const b = proposals[j]
      if (b === undefined) continue
      const sim = jaccard(proposalTokens(a), proposalTokens(b))
      if (sim >= duplicateThreshold) {
        merges.push({
          kind: 'merge',
          proposalId: a.id,
          title: `${a.frontmatter.title} + ${b.frontmatter.title}`,
          similarity: Math.round(sim * 1000) / 1000,
          reason: `两条待审提案相似度 ${(sim * 100).toFixed(0)}% —— 萃取重复产出`,
          suggestedAction: '批准其一，拒绝/编辑另一条，避免孪生入库',
        })
        matchedProposals.add(a.id)
        matchedProposals.add(b.id)
      } else if (sim >= mergeThreshold && a.frontmatter.type === b.frontmatter.type) {
        merges.push({
          kind: 'merge',
          proposalId: a.id,
          title: `${a.frontmatter.title} + ${b.frontmatter.title}`,
          similarity: Math.round(sim * 1000) / 1000,
          reason: `两条待审提案同类型、相似度 ${(sim * 100).toFixed(0)}%`,
          suggestedAction: '合并为一条提案再批准',
        })
        matchedProposals.add(a.id)
        matchedProposals.add(b.id)
      }
    }
  }

  // ── Fresh: proposals nothing above touched.
  for (const proposal of proposals) {
    if (!matchedProposals.has(proposal.id)) {
      fresh.push({
        kind: 'fresh',
        proposalId: proposal.id,
        title: proposal.frontmatter.title,
        reason: '与既有条目无显著重叠',
        suggestedAction: '常规批准流程',
      })
    }
  }

  return {
    generatedAt: nowIso(),
    duplicateThreshold,
    mergeThreshold,
    agingDays,
    proposalsAnalyzed: proposals.length,
    entriesAnalyzed: entries.length,
    duplicates,
    merges,
    aging,
    fresh,
  }
}
