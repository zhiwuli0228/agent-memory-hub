import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { journalDir } from './hub.js'
import { nowIso } from './time.js'

/**
 * Journal — the episodic layer. AUTO-CAPTURE ≠ AUTO-WRITE: journal files are
 * append-only, disposable, and NEVER indexed into search (knowledge stays the
 * only authoritative layer). One JSONL file per local day; trimming is a
 * caller decision (storage hygiene), not an automatic behavior.
 */

export interface JournalEntry {
  ts: string
  sessionId?: string
  /** Free-form episodic note (what happened in the conversation). */
  text: string
  [key: string]: unknown
}

function dayStamp(iso: string): string {
  return iso.slice(0, 10)
}

function journalFile(root: string, iso: string): string {
  const dir = journalDir(root)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${dayStamp(iso)}.jsonl`)
}

export interface AppendJournalInput {
  ts?: string
  sessionId?: string
  text: string
  [key: string]: unknown
}

/** Append one episodic entry to the day file. Never touches knowledge/. */
export function appendJournal(root: string, entry: AppendJournalInput): JournalEntry {
  const stamped: JournalEntry = { ...entry, ts: entry.ts ?? nowIso() }
  appendFileSync(journalFile(root, stamped.ts), `${JSON.stringify(stamped)}\n`, 'utf8')
  return stamped
}

/** Read one day's entries (or all days when day is omitted). */
export function readJournal(root: string, day?: string): JournalEntry[] {
  const dir = journalDir(root)
  if (!existsSync(dir)) return []
  const files =
    day !== undefined
      ? [join(dir, `${day}.jsonl`)]
      : readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .sort()
          .map((f) => join(dir, f))
  const out: JournalEntry[] = []
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as JournalEntry)
      } catch {
        // skip malformed lines — journal is disposable, never load-bearing
      }
    }
  }
  return out
}

/** Explicit trim: delete day files older than keepDays (caller decides when). */
export function trimJournal(root: string, keepDays: number, todayIso?: string): number {
  const dir = journalDir(root)
  if (!existsSync(dir)) return 0
  const cutoff = dayStamp(todayIso ?? nowIso())
  let removed = 0
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const day = file.replace('.jsonl', '')
    if (day < cutoff && isOlderThan(day, cutoff, keepDays)) {
      rmSync(join(dir, file), { force: true })
      removed += 1
    }
  }
  return removed
}

function isOlderThan(day: string, cutoff: string, keepDays: number): boolean {
  const dayMs = Date.parse(`${day}T00:00:00Z`)
  const cutoffMs = Date.parse(`${cutoff}T00:00:00Z`)
  if (Number.isNaN(dayMs) || Number.isNaN(cutoffMs)) return false
  return cutoffMs - dayMs > keepDays * 86_400_000
}
