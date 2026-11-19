import { randomUUID } from 'node:crypto'
import { ErrorCode, HubError } from './errors.js'
import type { KnowledgeType } from './types.js'

/** ID prefixes per knowledge type (shared contract with dsh-memory-hub). */
const PREFIX: Record<KnowledgeType, string> = {
  decision: 'DEC',
  constraint: 'CON',
  knowledge: 'KNO',
  'api-catalog': 'API',
  process: 'PRC',
  'open-questions': 'OPQ',
  'runtime-base': 'RTB',
  playbooks: 'PLB',
  assets: 'AST',
}

const PENDING_PREFIX = 'PRO'

/** Persisted per-type counters (records/sequences.json). */
export interface Sequences {
  [prefix: string]: number
}

export function prefixFor(type: KnowledgeType): string {
  return PREFIX[type]
}

/** Next ID for a knowledge type. Mutates and persists the sequence file.
 *
 * ADR-0023 federation collision guard: nodes pull each other's entries and
 * a persisted counter alone would re-emit IDs a peer already used (observed
 * live: both nodes minted PRC-000001 and the later pull overwrote the
 * other's entry). The floor is therefore max(sequence, max known id) —
 * ids already present anywhere in the local view always win. */
export function nextKnowledgeId(
  seqDir: string,
  type: KnowledgeType,
  readSequences: (dir: string) => Sequences,
  writeSequences: (dir: string, seq: Sequences) => void,
  knownIds?: Iterable<string>,
): string {
  const prefix = prefixFor(type)
  const seq = readSequences(seqDir)
  let next = (seq[prefix] ?? 0) + 1
  if (knownIds !== undefined) {
    const width = 6
    for (const id of knownIds) {
      if (!id.startsWith(`${prefix}-`)) continue
      const n = Number.parseInt(id.slice(prefix.length + 1), 10)
      if (Number.isFinite(n) && n >= next) next = n + 1
    }
  }
  seq[prefix] = next
  writeSequences(seqDir, seq)
  return `${prefix}-${String(next).padStart(6, '0')}`
}

/** Next pending proposal ID (PRO-…). Collision guard same as knowledge ids. */
export function nextProposalId(
  seqDir: string,
  readSequences: (dir: string) => Sequences,
  writeSequences: (dir: string, seq: Sequences) => void,
  knownIds?: Iterable<string>,
): string {
  const seq = readSequences(seqDir)
  let next = (seq[PENDING_PREFIX] ?? 0) + 1
  if (knownIds !== undefined) {
    for (const id of knownIds) {
      if (!id.startsWith(`${PENDING_PREFIX}-`)) continue
      const n = Number.parseInt(id.slice(PENDING_PREFIX.length + 1), 10)
      if (Number.isFinite(n) && n >= next) next = n + 1
    }
  }
  seq[PENDING_PREFIX] = next
  writeSequences(seqDir, seq)
  return `${PENDING_PREFIX}-${String(next).padStart(6, '0')}`
}

/** Fresh fencing token for the writer lock (monotonicity comes from time+random). */
export function newLockToken(): string {
  return `lk-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

export function assertNonEmpty(value: string, field: string): string {
  if (value.trim() === '') throw new HubError(ErrorCode.E_VALIDATION, `\`${field}\` must not be empty`)
  return value
}
