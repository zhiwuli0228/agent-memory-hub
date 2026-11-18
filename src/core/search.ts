import { listEntries } from './store.js'
import type { KnowledgeEntry } from './store.js'
import type { KnowledgeScope } from './types.js'

/**
 * Search: CJK bigram + ASCII word tokenization over an in-memory inverted
 * index with BM25-lite scoring and scope-ancestor filtering.
 *
 * Design rules (V2): directory-scoped before whole-index; L0/L1/L2 progressive
 * loading (abstract → overview → details); min_score is caller-calibrated via
 * ledger replay, never hard-coded folklore.
 */

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const CJK_RANGE = /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/

/** CJK bigrams + lowercase ASCII/digit words. Zero dependencies. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let ascii = ''
  let cjkRun: string[] = []
  const flushAscii = () => {
    if (ascii !== '') {
      tokens.push(ascii.toLowerCase())
      ascii = ''
    }
  }
  const flushCjk = () => {
    for (let i = 0; i < cjkRun.length - 1; i += 1) {
      tokens.push(`${cjkRun[i]}${cjkRun[i + 1]}`)
    }
    cjkRun = []
  }
  for (const char of text) {
    if (/[a-zA-Z0-9]/.test(char)) {
      flushCjk()
      ascii += char
    } else if (CJK_RANGE.test(char)) {
      flushAscii()
      cjkRun.push(char)
    } else {
      flushAscii()
      flushCjk()
    }
  }
  flushAscii()
  flushCjk()
  return tokens
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Field weights: title hits matter most, then summary/tags, then body. */
const FIELD_WEIGHTS = { title: 3, summary: 2, tags: 2, body: 1 } as const

interface IndexedDoc {
  id: string
  entry: KnowledgeEntry
  /** term -> weighted term frequency within this doc. */
  tf: Map<string, number>
  length: number
}

export interface SearchIndex {
  docs: Map<string, IndexedDoc>
  /** term -> doc ids containing it. */
  postings: Map<string, Set<string>>
  totalLength: number
  builtAt: string
}

export function buildIndex(root: string, nowIso: () => string): SearchIndex {
  const docs = new Map<string, IndexedDoc>()
  const postings = new Map<string, Set<string>>()
  let totalLength = 0
  for (const entry of listEntries(root)) {
    const bag = termBag(entry)
    const id = entry.frontmatter.id
    let length = 0
    for (const [term, tf] of bag) {
      length += tf
      let set = postings.get(term)
      if (set === undefined) {
        set = new Set()
        postings.set(term, set)
      }
      set.add(id)
    }
    docs.set(id, { id, entry, tf: bag, length })
    totalLength += length
  }
  return { docs, postings, totalLength, builtAt: nowIso() }
}

function termBag(entry: KnowledgeEntry): Map<string, number> {
  const bag = new Map<string, number>()
  const add = (text: string, weight: number) => {
    for (const term of tokenize(text)) {
      bag.set(term, (bag.get(term) ?? 0) + weight)
    }
  }
  add(entry.frontmatter.title, FIELD_WEIGHTS.title)
  add(entry.frontmatter.summary, FIELD_WEIGHTS.summary)
  add(entry.frontmatter.tags.join(' '), FIELD_WEIGHTS.tags)
  add(entry.body, FIELD_WEIGHTS.body)
  return bag
}

// ---------------------------------------------------------------------------
// Scope filtering (ADR-0002 + ADR-0019: viewer declares its access scope —
// global is always visible; a viewer may declare a team domain and/or a
// project workspace, and sees the union of those + global)
// ---------------------------------------------------------------------------

export interface ScopeViewer {
  /** Project workspace the viewer operates in (project-level entries). */
  workspaceId?: string
  /** Team domain the viewer belongs to (`domainId` in frontmatter — the reserved middle tier, now the team tier). */
  teamId?: string
}

/** Union visibility: global ∪ declared team ∪ declared project. */
export function isVisibleIn(scope: KnowledgeScope, viewer: ScopeViewer): boolean {
  if (scope.level === 'global') return true
  if (scope.level === 'domain') return viewer.teamId !== undefined && scope.domainId === viewer.teamId
  if (scope.level === 'project') return viewer.workspaceId !== undefined && scope.workspaceId === viewer.workspaceId
  return false
}

/** Legacy single-workspace view: the workspace sees itself + global only. */
export function isVisible(scope: KnowledgeScope, workspaceId: string): boolean {
  return isVisibleIn(scope, { workspaceId })
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export type DetailLevel = 'L0' | 'L1' | 'L2'

export interface SearchHit {
  id: string
  version: number
  type: string
  status: string
  title: string
  /** L0: one-line abstract. */
  abstract: string
  score: number
  scope: KnowledgeScope
  tags: string[]
  /** L1: full summary. */
  summary?: string
  /** L2: full body. */
  body?: string
}

export interface SearchMetrics {
  indexedCount: number
  queryCount: number
  totalHits: number
  lastHitCount: number
  lastQuery: string
  builtAt: string
}

export interface SearchOptions {
  /**
   * Visibility filter. Omit (undefined) to search the WHOLE hub — used by the
   * central read-side API (ADR-0018), where remote consumers have no workspace
   * context and the hub is a shared knowledge base by design.
   */
  workspaceId?: string
  /** Team domain the viewer belongs to (ADR-0019): adds that team's entries to the union. */
  teamId?: string
  detail?: DetailLevel
  minScore?: number
  limit?: number
  types?: string[]
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const LOCAL_BOOST = 1.2

/** Run a query against the index (pure read). */
export function search(index: SearchIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []
  const avgLength = index.docs.size === 0 ? 1 : index.totalLength / index.docs.size
  const scores = new Map<string, number>()
  for (const term of new Set(queryTerms)) {
    const posting = index.postings.get(term)
    if (posting === undefined) continue
    const idf = Math.log(1 + (index.docs.size - posting.size + 0.5) / (posting.size + 0.5))
    for (const docId of posting) {
      const doc = index.docs.get(docId)
      if (doc === undefined) continue
      const viewer = { workspaceId: options.workspaceId, teamId: options.teamId }
      if ((options.workspaceId !== undefined || options.teamId !== undefined) && !isVisibleIn(doc.entry.frontmatter.scope, viewer)) continue
      if (options.types !== undefined && !options.types.includes(doc.entry.frontmatter.type)) continue
      const tf = doc.tf.get(term) ?? 0
      const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgLength)))
      scores.set(docId, (scores.get(docId) ?? 0) + idf * norm)
    }
  }
  const minScore = options.minScore ?? 0
  const hits: SearchHit[] = []
  for (const [docId, score] of scores) {
    if (score < minScore) continue
    const doc = index.docs.get(docId)
    if (doc === undefined) continue
    // Local boost: entries of the querying scope (project or team) rank higher (predecessor DEC-000002, ADR-0019).
    const scope = doc.entry.frontmatter.scope
    const inScope =
      (scope.level === 'project' && options.workspaceId !== undefined && scope.workspaceId === options.workspaceId) ||
      (scope.level === 'domain' && options.teamId !== undefined && scope.domainId === options.teamId)
    const boosted = inScope ? score * LOCAL_BOOST : score
    hits.push(toHit(doc, boosted, options.detail ?? 'L1'))
  }
  hits.sort((a, b) => b.score - a.score)
  return options.limit !== undefined ? hits.slice(0, options.limit) : hits
}

function toHit(doc: IndexedDoc, score: number, detail: DetailLevel): SearchHit {
  const fm = doc.entry.frontmatter
  const hit: SearchHit = {
    id: fm.id,
    version: fm.version,
    type: fm.type,
    status: fm.status,
    title: fm.title,
    abstract: firstLine(fm.summary, 80),
    score: Math.round(score * 1000) / 1000,
    scope: fm.scope,
    tags: fm.tags,
  }
  if (detail === 'L1' || detail === 'L2') hit.summary = fm.summary
  if (detail === 'L2') hit.body = doc.entry.body
  return hit
}

function firstLine(text: string, maxChars: number): string {
  const line = text.split('\n')[0] ?? ''
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}…`
}

/** Query with metrics bookkeeping (mutates a metrics record owned by the caller). */
export function searchWithMetrics(
  index: SearchIndex,
  metrics: SearchMetrics,
  query: string,
  options: SearchOptions,
): SearchHit[] {
  const hits = search(index, query, options)
  metrics.queryCount += 1
  metrics.totalHits += hits.length
  metrics.lastHitCount = hits.length
  metrics.lastQuery = query
  return hits
}

export function emptyMetrics(index: SearchIndex): SearchMetrics {
  return {
    indexedCount: index.docs.size,
    queryCount: 0,
    totalHits: 0,
    lastHitCount: 0,
    lastQuery: '',
    builtAt: index.builtAt,
  }
}
