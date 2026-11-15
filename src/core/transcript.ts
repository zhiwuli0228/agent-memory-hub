import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tokenize } from './search.js'
import { atomicWrite } from './atomic.js'

/**
 * Day-zero transcript index (the deja-vu route): hosts keep transcript bodies
 * authoritative; we store only a compact per-session token index + a short
 * preview. Deja-vu = a new task's intent matches tokens from earlier sessions,
 * surfaced BEFORE duplication happens (day zero), not by dedup afterwards.
 */

export interface TranscriptRecord {
  sessionId: string
  /** ISO timestamp of the session (or its first message). */
  at: string
  /** Bigram/word token set (serialized array) — the only searchable content. */
  tokens: string[]
  /** ≤160 char preview for human display; never searched. */
  preview: string
  /** Host-side pointer back to the full body (path/URL — host resolves it). */
  location: string
}

export const TRANSCRIPT_INDEX_FILE = 'records/transcript-index.jsonl'

function indexPath(root: string): string {
  return join(root, TRANSCRIPT_INDEX_FILE)
}

/** Index one session transcript: tokens + preview only (body stays with the host). */
export function indexTranscript(
  root: string,
  input: { sessionId: string; at?: string; text: string; location: string },
): TranscriptRecord {
  const tokens = [...new Set(tokenize(input.text))]
  const record: TranscriptRecord = {
    sessionId: input.sessionId,
    at: input.at ?? new Date().toISOString(),
    tokens,
    preview: input.text.replace(/\s+/g, ' ').slice(0, 160),
    location: input.location,
  }
  appendFileSync(indexPath(root), `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

export function readTranscriptIndex(root: string): TranscriptRecord[] {
  const path = indexPath(root)
  if (!existsSync(path)) return []
  const out: TranscriptRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as TranscriptRecord)
    } catch {
      // skip malformed
    }
  }
  return out
}

export interface DejaVu {
  sessionId: string
  at: string
  preview: string
  location: string
  /** Jaccard overlap between the query tokens and the session tokens. */
  overlap: number
}

/**
 * Detect deja-vu: sessions whose token set overlaps the query tokens above the
 * threshold (default 0.35 — deliberately conservative; this is a hint, not a
 * verdict). Read-only; the host decides what to do with the pointer.
 */
export function detectDejaVu(root: string, query: string, threshold?: number): DejaVu[] {
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) return []
  const min = threshold ?? 0.35
  const hits: DejaVu[] = []
  for (const record of readTranscriptIndex(root)) {
    const set = new Set(record.tokens)
    let shared = 0
    for (const token of queryTokens) if (set.has(token)) shared += 1
    const overlap = shared / queryTokens.size
    if (overlap >= min) {
      hits.push({
        sessionId: record.sessionId,
        at: record.at,
        preview: record.preview,
        location: record.location,
        overlap: Math.round(overlap * 1000) / 1000,
      })
    }
  }
  return hits.sort((a, b) => b.overlap - a.overlap)
}

/** Rebuild the index file atomically (dedup by sessionId keeps the latest). */
export function rebuildTranscriptIndex(root: string, records: TranscriptRecord[]): void {
  const bySession = new Map<string, TranscriptRecord>()
  for (const record of records) bySession.set(record.sessionId, record)
  const lines = [...bySession.values()].map((r) => `${JSON.stringify(r)}\n`)
  atomicWrite(indexPath(root), lines.join(''))
}
