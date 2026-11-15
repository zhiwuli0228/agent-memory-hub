import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.js'
import { ErrorCode, HubError } from './errors.js'
import { historyDir, knowledgeDir, pendingDir } from './hub.js'
import { nextKnowledgeId, nextProposalId } from './ids.js'
import { parseIso, nowIso } from './time.js'
import { parseKnowledgeFile, parseKnowledgeFrontmatter } from './frontmatter.js'
import type { LedgerRecord } from './ledger.js'
import type {
  KnowledgeFrontmatter,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
} from './types.js'

/**
 * Store: knowledge / pending / history CRUD. All writes are atomic; every
 * knowledge mutation snapshots the previous version into history/ (append-only)
 * and appends a ledger record (caller supplies the ledger callback).
 */

export interface SaveKnowledgeInput {
  type: KnowledgeType
  title: string
  summary: string
  scope: KnowledgeScope
  tags?: string[]
  body: string
  /** Existing entry id to update; omit to create a new one. */
  id?: string
  /** Expires-at ISO timestamp (aging / validity window). */
  expiresAt?: string
  sourceRefs?: string[]
  actor?: string
}

export interface KnowledgeEntry {
  frontmatter: KnowledgeFrontmatter
  body: string
  path: string
  /** Epoch ms when the entry expires (aging), or null. */
  expiresAtMs: number | null
  /** True when status is deprecated or expiresAt has passed (soft-removed). */
  softRemoved: boolean
}

function entryPath(root: string, type: KnowledgeType, id: string): string {
  return join(knowledgeDir(root, type), `${id}.md`)
}

export function renderKnowledgeMarkdown(fm: KnowledgeFrontmatter, body: string): string {
  const lines: string[] = ['---']
  lines.push(`id: ${fm.id}`)
  lines.push(`version: ${fm.version}`)
  lines.push(`type: ${fm.type}`)
  lines.push(`status: ${fm.status}`)
  lines.push(`title: ${fm.title}`)
  lines.push(`summary: ${fm.summary}`)
  if (fm.scope.level === 'global') {
    lines.push('scope:')
    lines.push('  level: global')
  } else if (fm.scope.level === 'domain') {
    lines.push('scope:')
    lines.push('  level: domain')
    lines.push(`  domainId: ${fm.scope.domainId}`)
  } else {
    lines.push('scope:')
    lines.push('  level: project')
    lines.push(`  workspaceId: ${fm.scope.workspaceId}`)
  }
  lines.push(`tags: [${fm.tags.join(', ')}]`)
  if (fm.created !== undefined) lines.push(`created: ${fm.created}`)
  if (fm.updated !== undefined) lines.push(`updated: ${fm.updated}`)
  if (fm.last_verified !== undefined) lines.push(`last_verified: ${fm.last_verified}`)
  for (const [key, value] of Object.entries(fm.extra)) {
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  lines.push('---')
  lines.push('')
  lines.push(body.trimEnd())
  lines.push('')
  return lines.join('\n')
}

/** Read one knowledge entry by id (searches all type dirs). */
export function getEntry(root: string, id: string): KnowledgeEntry {
  for (const type of readdirSync(join(root, 'knowledge'))) {
    const path = entryPath(root, type as KnowledgeType, id)
    if (!existsSync(path)) continue
    const raw = readFileSync(path, 'utf8')
    const parsed = parseKnowledgeFile(raw)
    return toEntry(parsed.frontmatter, parsed.body, path)
  }
  throw new HubError(ErrorCode.E_NOT_FOUND, `knowledge entry not found: ${id}`, { id })
}

function toEntry(fm: KnowledgeFrontmatter, body: string, path: string): KnowledgeEntry {
  const expiresRaw = fm.extra['expires_at']
  const expiresAtMs = parseIso(typeof expiresRaw === 'string' ? expiresRaw : undefined)
  return {
    frontmatter: fm,
    body,
    path,
    expiresAtMs,
    softRemoved: fm.status === 'deprecated' || (expiresAtMs !== null && expiresAtMs <= Date.now()),
  }
}

/** List all entries; soft-removed included unless includeSoftRemoved=false. */
export function listEntries(root: string, options?: { includeSoftRemoved?: boolean }): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = []
  const typesRoot = join(root, 'knowledge')
  if (!existsSync(typesRoot)) return out
  for (const type of readdirSync(typesRoot)) {
    const dir = knowledgeDir(root, type)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const path = join(dir, file)
      try {
        const parsed = parseKnowledgeFile(readFileSync(path, 'utf8'))
        const entry = toEntry(parsed.frontmatter, parsed.body, path)
        if (options?.includeSoftRemoved !== true && entry.softRemoved) continue
        out.push(entry)
      } catch {
        // Unreadable entry: skip, never break listing (index rebuildable).
      }
    }
  }
  return out
}

/** Title-level conflict detection: same title among accepted entries. */
export function findTitleConflict(root: string, title: string, excludeId?: string): KnowledgeEntry | null {
  const hit = listEntries(root).find(
    (entry) => entry.frontmatter.title === title && entry.frontmatter.id !== excludeId,
  )
  return hit ?? null
}

/**
 * Create or update a knowledge entry. Creates are caller-authorized (the human
 * approval already happened — this function is the post-approval write path).
 * Updates snapshot the previous version into history/ first.
 */
export function commitKnowledge(
  root: string,
  input: SaveKnowledgeInput,
  helpers: {
    nowIsoValue?: string
    readSequences: (root: string) => Record<string, number>
    writeSequences: (root: string, seq: Record<string, number>) => void
    appendLedger: (root: string, record: LedgerRecord) => void
  },
): { id: string; version: number; path: string } {
  const ts = helpers.nowIsoValue ?? nowIso()
  if (input.id === undefined) {
    // create
    const conflict = findTitleConflict(root, input.title)
    if (conflict !== null) {
      throw new HubError(ErrorCode.E_CONFLICT, `an accepted entry with the same title exists: ${conflict.frontmatter.id}`, {
        existingId: conflict.frontmatter.id,
        existingTitle: conflict.frontmatter.title,
      })
    }
    const id = nextKnowledgeId(root, input.type, helpers.readSequences, helpers.writeSequences)
    const fm: KnowledgeFrontmatter = {
      id,
      version: 1,
      type: input.type,
      status: 'accepted',
      title: input.title,
      summary: input.summary,
      scope: input.scope,
      tags: input.tags ?? [],
      created: ts,
      updated: ts,
      last_verified: ts,
      extra: input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {},
    }
    const path = entryPath(root, input.type, id)
    atomicWrite(path, renderKnowledgeMarkdown(fm, input.body))
    helpers.appendLedger(root, {
      ts,
      actor: input.actor ?? 'human',
      action: 'approve',
      id,
      version: 1,
      source_refs: input.sourceRefs,
    })
    return { id, version: 1, path }
  }
  // update: snapshot previous version into history/, then write version+1
  const previous = getEntry(root, input.id)
  const prevFm = previous.frontmatter
  if (prevFm.type !== input.type) {
    throw new HubError(ErrorCode.E_VALIDATION, `type mismatch for ${input.id}: ${prevFm.type} ≠ ${input.type}`)
  }
  const historyPath = join(historyDir(root, prevFm.type), `${prevFm.id}@v${prevFm.version}.md`)
  atomicWrite(historyPath, readFileSync(previous.path, 'utf8'))
  const fm: KnowledgeFrontmatter = {
    ...prevFm,
    version: prevFm.version + 1,
    title: input.title,
    summary: input.summary,
    tags: input.tags ?? prevFm.tags,
    updated: ts,
    last_verified: ts,
    extra: input.expiresAt !== undefined ? { ...prevFm.extra, expires_at: input.expiresAt } : prevFm.extra,
  }
  atomicWrite(previous.path, renderKnowledgeMarkdown(fm, input.body))
  helpers.appendLedger(root, {
    ts,
    actor: input.actor ?? 'human',
    action: 'update',
    id: prevFm.id,
    version: fm.version,
    source_refs: input.sourceRefs,
  })
  return { id: prevFm.id, version: fm.version, path: previous.path }
}

/** Soft-remove: status=deprecated + ledger record. Physical delete is explicit-only. */
export function deprecateEntry(
  root: string,
  id: string,
  reason: string,
  helpers: {
    nowIsoValue?: string
    appendLedger: (root: string, record: LedgerRecord) => void
  },
): void {
  const entry = getEntry(root, id)
  const ts = helpers.nowIsoValue ?? nowIso()
  const fm: KnowledgeFrontmatter = { ...entry.frontmatter, status: 'deprecated', updated: ts }
  atomicWrite(entry.path, renderKnowledgeMarkdown(fm, entry.body))
  helpers.appendLedger(root, {
    ts,
    actor: 'human',
    action: 'deprecate',
    id,
    version: entry.frontmatter.version,
    note: reason,
  })
}

/** Hard delete (GDPR path): explicit caller authorization required; ledger first, then unlink. */
export function hardDeleteEntry(
  root: string,
  id: string,
  reason: string,
  helpers: {
    nowIsoValue?: string
    appendLedger: (root: string, record: LedgerRecord) => void
  },
): void {
  const entry = getEntry(root, id)
  const ts = helpers.nowIsoValue ?? nowIso()
  helpers.appendLedger(root, {
    ts,
    actor: 'human',
    action: 'delete',
    id,
    version: entry.frontmatter.version,
    note: reason,
  })
  rmSync(entry.path, { force: true })
}

/** Create a pending candidate (models may do this; humans approve via commitKnowledge).
 * `supersedes` names an existing entry this proposal re-extracts: approving it
 * bumps that entry's version instead of creating a duplicate. */
export function createProposal(
  root: string,
  input: Omit<SaveKnowledgeInput, 'id'> & { sourceRefs: string[]; supersedes?: string[] },
  helpers: {
    nowIsoValue?: string
    readSequences: (root: string) => Record<string, number>
    writeSequences: (root: string, seq: Record<string, number>) => void
    appendLedger: (root: string, record: LedgerRecord) => void
  },
): { id: string; path: string } {
  const ts = helpers.nowIsoValue ?? nowIso()
  const proposalId = nextProposalId(root, helpers.readSequences, helpers.writeSequences)
  const fm: KnowledgeFrontmatter = {
    id: proposalId,
    version: 1,
    type: input.type,
    status: 'candidate',
    title: input.title,
    summary: input.summary,
    scope: input.scope,
    tags: input.tags ?? [],
    created: ts,
    updated: ts,
    extra: {
      source_refs: input.sourceRefs.join(' '),
      ...(input.supersedes !== undefined && input.supersedes.length > 0 ? { supersedes: input.supersedes.join(' ') } : {}),
    },
  }
  const path = join(pendingDir(root), `${proposalId}.md`)
  atomicWrite(path, renderKnowledgeMarkdown(fm, input.body))
  helpers.appendLedger(root, {
    ts,
    actor: input.actor ?? 'model',
    action: 'propose',
    id: proposalId,
    source_refs: input.sourceRefs,
    ...(input.supersedes !== undefined && input.supersedes.length > 0 ? { supersedes: input.supersedes } : {}),
  })
  return { id: proposalId, path }
}

/** List pending candidates. */
export function listProposals(root: string): Array<{ id: string; frontmatter: KnowledgeFrontmatter; path: string }> {
  const dir = pendingDir(root)
  if (!existsSync(dir)) return []
  const out: Array<{ id: string; frontmatter: KnowledgeFrontmatter; path: string }> = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const path = join(dir, file)
    try {
      const fm = parseKnowledgeFrontmatter(readFileSync(path, 'utf8'), { context: 'proposal' })
      out.push({ id: fm.id, frontmatter: fm, path })
    } catch {
      // skip unreadable candidate
    }
  }
  return out
}

/** All statuses the store understands. */
export const STATUSES: readonly KnowledgeStatus[] = ['candidate', 'accepted', 'rejected', 'superseded', 'deprecated']
