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
  | 'delete'
  | 'register-workspace'
  | 'conflict-freeze'

export interface LedgerRecord {
  ts: string
  actor: string
  action: LedgerAction
  id?: string
  version?: number
  /** Evidence refs backing the decision (file:/session:/url:/note:). */
  source_refs?: string[]
  note?: string
  /** Extra structured fields (e.g. approval.missing, lock info). */
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
