import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  } else if (fm.scope.level === 'private') {
    lines.push('scope:')
    lines.push('  level: private')
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
  for (const base of [join(root, 'knowledge'), join(root, 'knowledge-private')]) {
    if (!existsSync(base)) continue
    for (const type of readdirSync(base)) {
      const path = join(base, type, `${id}.md`)
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      const parsed = parseKnowledgeFile(raw)
      return toEntry(parsed.frontmatter, parsed.body, path)
    }
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
  // ADR-0023: local views span shared knowledge/ AND personal knowledge-private/
  // (gitignored); the git repos only ever see the shared half.
  for (const base of [join(root, 'knowledge'), join(root, 'knowledge-private')]) {
    if (!existsSync(base)) continue
    for (const type of readdirSync(base)) {
      const dir = join(base, type)
      if (!existsSync(dir)) continue
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
  }
  return out
}

/**
 * Title → id cache for O(1) conflict checks (ADR-0021: a 150-person org
 * writes thousands of entries; re-scanning the whole hub per commit is O(n²)).
 * Invalidated by any knowledge/ subdirectory mtime change (file adds/removes
 * change their parent type dir's mtime).
 */
const titleCache = new Map<string, { stamp: string; titles: Map<string, string> }>()

function titleMap(root: string): Map<string, string> {
  const stamp = cacheStamp(root)
  const hit = titleCache.get(root)
  if (hit !== undefined && hit.stamp === stamp) return hit.titles
  const titles = new Map<string, string>()
  const bases = [join(root, 'knowledge'), join(root, 'knowledge-private')].filter((b) => existsSync(b))
  for (const base of bases) {
    for (const type of readdirSync(base)) {
      for (const file of readdirSync(join(base, type))) {
        if (!file.endsWith('.md')) continue
        try {
          const parsed = parseKnowledgeFile(readFileSync(join(base, type, file), 'utf8'))
          if (parsed.frontmatter.extra['soft_removed'] === true) continue
          titles.set(parsed.frontmatter.title, parsed.frontmatter.id)
        } catch {
          // Unreadable entry: skip (same policy as listEntries).
        }
      }
    }
  }
  titleCache.set(root, { stamp, titles })
  return titles
}

/**
 * In-process incremental update after OUR OWN commit: the directory mtime we
 * caused must not invalidate the cache (that would restore O(n²)). Registering
 * the new title and re-stamping keeps the cache warm in O(1). Cross-process
 * writes still invalidate via the stamp on next read.
 */
/** Shared stamp format for titleCache — MUST be identical in writer & reader. */
function cacheStamp(root: string): string {
  const bases = [join(root, 'knowledge'), join(root, 'knowledge-private')].filter((b) => existsSync(b))
  let stamp = ''
  for (const base of bases) {
    for (const t of readdirSync(base)) {
      stamp += `${base}:${Math.floor(statSync(join(base, t)).mtimeMs)};`
    }
  }
  return stamp
}

function cacheAddTitle(root: string, title: string, id: string): void {
  const hit = titleCache.get(root)
  if (hit === undefined) return // no cache yet — next read builds it fresh
  hit.titles.set(title, id)
  hit.stamp = cacheStamp(root) // admit the mtime change we ourselves caused
}

/** Title-level conflict detection: same title among accepted entries. O(1) via cache. */
export function findTitleConflict(root: string, title: string, excludeId?: string): KnowledgeEntry | null {
  const id = titleMap(root).get(title)
  if (id === undefined || id === excludeId) return null
  return getEntry(root, id)
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
    // ADR-0023: personal (private) memories are written per-person WITHOUT
    // dedup — "每个人不去重" — no title-conflict gate on the private tier.
    if (input.scope.level !== 'private') {
      const conflict = findTitleConflict(root, input.title)
      if (conflict !== null) {
        throw new HubError(ErrorCode.E_CONFLICT, `an accepted entry with the same title exists: ${conflict.frontmatter.id}`, {
          existingId: conflict.frontmatter.id,
          existingTitle: conflict.frontmatter.title,
        })
      }
    }
    // ADR-0023: floor the sequence at the max id already visible locally so
    // pulled peer entries can never be overwritten by a re-minted local id.
    const id = nextKnowledgeId(root, input.type, helpers.readSequences, helpers.writeSequences, titleMap(root).values())
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
    // ADR-0023 three-tier federation: private entries live under
    // knowledge-private/ (gitignored) so team/department git repos carry
    // ONLY shared knowledge.
    const path = input.scope.level === 'private' ? join(root, 'knowledge-private', input.type, `${id}.md`) : entryPath(root, input.type, id)
    mkdirSync(dirname(path), { recursive: true })
    atomicWrite(path, renderKnowledgeMarkdown(fm, input.body))
    helpers.appendLedger(root, {
      ts,
      actor: input.actor ?? 'human',
      action: 'approve',
      id,
      version: 1,
      source_refs: input.sourceRefs,
    })
    cacheAddTitle(root, input.title, id)
    return { id, version: 1, path }
  }
  // Explicit id: ADR-0012 cross-hub upsert. When the id does not exist
  // locally yet, it is created AS that id (keeps hub-to-hub identity
  // stable); otherwise it is the usual version upgrade.
  let previous: { frontmatter: KnowledgeFrontmatter; path: string; body: string }
  try {
    const found = getEntry(root, input.id)
    previous = { frontmatter: found.frontmatter, path: found.path, body: found.body }
  } catch {
    const fm: KnowledgeFrontmatter = {
      id: input.id,
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
    const path = entryPath(root, input.type, input.id)
    atomicWrite(path, renderKnowledgeMarkdown(fm, input.body))
    helpers.appendLedger(root, {
      ts,
      actor: input.actor ?? 'human',
      action: 'approve',
      id: input.id,
      version: 1,
      source_refs: input.sourceRefs,
    })
    return { id: input.id, version: 1, path }
  }
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
  input: Omit<SaveKnowledgeInput, 'id'> & { sourceRefs: string[]; supersedes?: string[]; origin?: string; originId?: string },
  helpers: {
    nowIsoValue?: string
    readSequences: (root: string) => Record<string, number>
    writeSequences: (root: string, seq: Record<string, number>) => void
    appendLedger: (root: string, record: LedgerRecord) => void
  },
): { id: string; path: string } {
  const ts = helpers.nowIsoValue ?? nowIso()
  // Same collision guard as knowledge ids: pending proposals pulled or
  // created earlier locally must never be re-minted.
  const proposalId = nextProposalId(root, helpers.readSequences, helpers.writeSequences, listProposals(root).map((p) => p.id))
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
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.originId !== undefined ? { origin_id: input.originId } : {}),
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
