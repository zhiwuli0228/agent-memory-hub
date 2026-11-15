import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.js'
import { readLedger, ledgerPath } from './ledger.js'
import { listEntries, listProposals } from './store.js'

/**
 * Trigger-agnostic extraction protocol (ADR-0011): ANY scheduler (cron,
 * Task Scheduler, an agent-workflow platform, CI) drives extraction by
 * calling the CLI — never a specific host. The host supplies the model,
 * memhub supplies the material and the write path.
 *
 *   1. `memhub extract material`  → what changed since the last extraction
 *      (ledger events + current entries), JSON for an LLM agent to consume
 *   2. the agent distills/generalizes → `memhub propose` (pending queue)
 *   3. human approves (panel / inbox) → `memhub validate` → `memhub sync push`
 *   4. `memhub extract done`      → advances the watermark
 */

interface ExtractState {
  lastExtractedAt: string
  extractionCount: number
}

export const EXTRACT_STATE_FILE = 'extract-state.json'

function extractStatePath(root: string): string {
  return join(root, 'records', EXTRACT_STATE_FILE)
}

export function readExtractState(root: string): ExtractState {
  const path = extractStatePath(root)
  if (!existsSync(path)) return { lastExtractedAt: '', extractionCount: 0 }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExtractState>
    return {
      lastExtractedAt: typeof raw['lastExtractedAt'] === 'string' ? raw['lastExtractedAt'] : '',
      extractionCount: typeof raw['extractionCount'] === 'number' ? raw['extractionCount'] : 0,
    }
  } catch {
    return { lastExtractedAt: '', extractionCount: 0 }
  }
}

export function writeExtractState(root: string, at: string): void {
  const previous = readExtractState(root)
  atomicWrite(
    extractStatePath(root),
    JSON.stringify({ lastExtractedAt: at, extractionCount: previous.extractionCount + 1 }, null, 2) + '\n',
  )
}

/** Minimal ledger projection for extraction: small, comparable, LLM-friendly. */
export interface ExtractLedgerEvent {
  ts: string
  actor?: string
  action?: string
  type?: string
  id?: string
  version?: number
}

export interface ExtractionMaterial {
  since: string
  now: string
  ledgerEvents: ExtractLedgerEvent[]
  truncated: boolean
  entries: Array<{ id: string; type: string; status: string; version: number; title: string; summary: string; updated: string; tags: string[] }>
  pendingTitles: string[]
  instruction: string
}

const LEDGER_CAP = 500

export function buildExtractionMaterial(root: string, since?: string): ExtractionMaterial {
  const state = readExtractState(root)
  const effectiveSince = since ?? state.lastExtractedAt
  const nowIso = new Date().toISOString()

  const all = readLedger(ledgerPath(root)) as Array<Record<string, unknown>>
  let events = all
  if (effectiveSince !== '') {
    events = all.filter((r) => typeof r['ts'] === 'string' && (r['ts'] as string) > effectiveSince)
  }
  const truncated = events.length > LEDGER_CAP
  const projected: ExtractLedgerEvent[] = events.slice(-LEDGER_CAP).map((r) => ({
    ts: String(r['ts'] ?? ''),
    ...(typeof r['actor'] === 'string' ? { actor: r['actor'] as string } : {}),
    ...(typeof r['action'] === 'string' ? { action: r['action'] as string } : {}),
    ...(typeof r['type'] === 'string' ? { type: r['type'] as string } : {}),
    ...(typeof r['id'] === 'string' ? { id: r['id'] as string } : {}),
    ...(typeof r['version'] === 'number' ? { version: r['version'] as number } : {}),
  }))

  const entries = listEntries(root, { includeSoftRemoved: false }).map((e) => ({
    id: e.frontmatter.id,
    type: e.frontmatter.type,
    status: e.frontmatter.status,
    version: e.frontmatter.version,
    title: e.frontmatter.title,
    summary: e.frontmatter.summary,
    updated: e.frontmatter.updated ?? '',
    tags: e.frontmatter.tags,
  }))

  return {
    since: effectiveSince,
    now: nowIso,
    ledgerEvents: projected,
    truncated,
    entries,
    pendingTitles: listProposals(root).map((p) => p.frontmatter.title),
    instruction:
      'Distill REUSABLE, host-agnostic knowledge from ledgerEvents. Generalize environment-specific flows ' +
      '(parameters -> placeholders, per-env details -> a dedicated section). Propose with `memhub propose` ' +
      '(use supersedes to re-extract an existing entry instead of duplicating). Never re-propose something ' +
      'already in entries. End the run with `memhub extract done`.',
  }
}
