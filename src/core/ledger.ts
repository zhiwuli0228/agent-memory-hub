import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.js'
import { LEDGER_FILE, SEQUENCES_FILE } from './hub.js'
import type { Sequences } from './ids.js'

/**
 * Approval ledger — append-only JSONL. Every write into knowledge/ has a
 * corresponding record here: who, when, on what evidence (invariant 2).
 * Never rewritten, never compacted (storage contract rule 3).
 */

export type LedgerAction =
  | 'propose'
  | 'approve'
  | 'reject'
  | 'update'
  | 'deprecate'
  | 'restore'
  | 'delete'
  | 'register-workspace'
  | 'conflict-freeze'
  | 'publish'

/**
 * Event-stream record (the predecessor ledger shape — type discriminates the
 * event; see docs/04-development/search-replay-2026-11-15.md appendix).
 * knowledge-lifecycle events carry ts/actor/action/id/version convenience
 * fields; harness events (citation.added, approval.missing, proposal.committed…)
 * carry only type + their own payload.
 */
export interface LedgerRecord {
  type?: string
  ts?: string
  actor?: string
  action?: LedgerAction
  id?: string
  version?: number
  /** Evidence refs backing the decision (file:/session:/url:/note:). */
  source_refs?: string[]
  note?: string
  [key: string]: unknown
}

export function ledgerPath(root: string): string {
  return join(root, LEDGER_FILE)
}

/** Append one record. The whole file is rewritten atomically (append = read+atomicWrite). */
export function appendLedger(path: string, record: LedgerRecord): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  atomicWrite(path, existing + `${JSON.stringify(record)}\n`)
}

export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerRecord)
}

export function readSequences(root: string): Sequences {
  const path = join(root, SEQUENCES_FILE)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Sequences
  } catch {
    return {}
  }
}

export function writeSequences(root: string, seq: Sequences): void {
  atomicWrite(join(root, SEQUENCES_FILE), `${JSON.stringify(seq, null, 2)}\n`)
}
