import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWrite } from './atomic.js'
import { ErrorCode, HubError } from './errors.js'
import { historyDir, knowledgeDir, pendingDir } from './hub.js'
import { nextKnowledgeId, nextProposalId } from './ids.js'
import { parseIso, nowIso } from './time.js'
import { parseKnowledgeFile, parseKnowledgeFrontmatter, splitFrontmatter } from './frontmatter.js'
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

/**
 * ADR-0024 rev 3: knowledge inside the ONE repo is TIERED by scope —
 * `knowledge/department/` (部门层, global) vs `knowledge/groups/<domainId>/`
 * (小组层). The layout is identical locally and in the central repo, so a
 * clone of the git repo IS the tiered structure; no sync-time remapping.
 * private stays physically outside (knowledge-private/, gitignored).
 */
function knowledgePath(root: string, type: KnowledgeType, id: string, scope: KnowledgeFrontmatter['scope']): string {
  if (scope.level === 'global') return join(root, 'knowledge', 'department', type, `${id}.md`)
  if (scope.level === 'domain') return join(root, 'knowledge', 'groups', scope.domainId, type, `${id}.md`)
  if (scope.level === 'project') return join(root, 'knowledge', 'projects', scope.workspaceId, type, `${id}.md`)
  return join(root, 'knowledge-private', type, `${id}.md`)
}

/** Recursive .md finder — reads tolerate BOTH the legacy flat layout and
 * the tiered layout (frontmatter scope stays the authority, not the path). */
function* walkMd(base: string): Generator<string> {
  if (!existsSync(base)) return
  for (const e of readdirSync(base, { withFileTypes: true })) {
    const p = join(base, e.name)
    if (e.isDirectory()) yield* walkMd(p)
    else if (e.name.endsWith('.md')) yield p
  }
}

/** Directories down to `maxDepth` — the titleCache stamp set. */
function* walkDirs(base: string, depth = 0, maxDepth = 3): Generator<string> {
  if (!existsSync(base) || depth > maxDepth) return
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(base, e.name)
    yield p
    yield* walkDirs(p, depth + 1, maxDepth)
  }
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

/** Read one knowledge entry by id (recursive across the tiered tree). */
export function getEntry(root: string, id: string): KnowledgeEntry {
  for (const base of [join(root, 'knowledge'), join(root, 'knowledge-private')]) {
    for (const path of walkMd(base)) {
      if (!path.endsWith(`${id}.md`)) continue
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
    for (const path of walkMd(base)) {
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
    for (const path of walkMd(base)) {
      try {
        const parsed = parseKnowledgeFile(readFileSync(path, 'utf8'))
        if (parsed.frontmatter.extra['soft_removed'] === true) continue
        titles.set(parsed.frontmatter.title, parsed.frontmatter.id)
      } catch {
        // Unreadable entry: skip (same policy as listEntries).
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
/** Shared stamp format for titleCache — MUST be identical in writer & reader.
 * Tiered layout: directories down to depth 3 (department/<type>, groups/<domain>
 * and groups/<domain>/<type>) — file writes bump their containing dir's mtime.
 * Git pulls only change FILE mtimes, so sync pull bumps dirs explicitly. */
function cacheStamp(root: string): string {
  let stamp = ''
  for (const base of [join(root, 'knowledge'), join(root, 'knowledge-private')]) {
    stamp += `${base}:${existsSync(base) ? Math.floor(statSync(base).mtimeMs) : 0};`
    for (const dir of walkDirs(base)) stamp += `${dir}:${Math.floor(statSync(dir).mtimeMs)};`
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
    // ADR-0023 three-tier federation + ADR-0024 rev 3 tiered layout:
    // private → knowledge-private/ (gitignored); shared → department/ or
    // groups/<domainId>/ so the git repo IS the tiered structure.
    const path = knowledgePath(root, input.type, id, input.scope)
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
    const path = knowledgePath(root, input.type, input.id, input.scope)
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

/**
 * Commit one pending proposal through the human-approval gate. THE single
 * implementation behind every approval surface (CLI `memhub inbox approve`,
 * serve-panel HTTP API, MCP commit tool) — S1 pilot found the CLI path had
 * its own copy that ignored `supersedes`, so a revision with the same title
 * was rejected by the dedup guard instead of bumping the target's version.
 *
 * Target selection (ADR-0012): `origin_id` = cross-hub upsert target (a
 * pushed entry applied on the central hub — create-as-id or version bump);
 * `supersedes` = local re-extraction target (requires it to exist). Either
 * keeps entry identity stable: never a duplicate.
 *
 * D06 arbitration (ADR-0025): a supersedes revision records the target
 * version it was based on (`supersedes_base`, stamped by createProposal). If
 * the target has since advanced, the revision is a CONCURRENT DIVERGENCE —
 * approving it would silently overwrite someone else's evidence. It is
 * isolated as a dispute instead: nothing is written, the proposal stays in
 * the inbox, the ledger records dispute.raised, and a human either rejects
 * it or explicitly overrides (audited dispute.overridden).
 */
export function commitProposal(
  root: string,
  proposal: { id: string; path: string; frontmatter: KnowledgeFrontmatter },
  helpers: {
    readSequences: (root: string) => Record<string, number>
    writeSequences: (root: string, seq: Record<string, number>) => void
    appendLedger: (root: string, record: LedgerRecord) => void
  },
  opts?: { channel?: string; note?: string; override?: boolean },
): CommitProposalResult {
  const rawOriginId = proposal.frontmatter.extra['origin_id']
  const originId = typeof rawOriginId === 'string' && rawOriginId !== '' && rawOriginId !== '[]' ? rawOriginId : undefined
  const rawSupersedes = proposal.frontmatter.extra['supersedes']
  const supersedesTarget =
    typeof rawSupersedes === 'string' && rawSupersedes !== '' && rawSupersedes !== '[]'
      ? rawSupersedes.split(/\s+/)[0]
      : undefined
  const rawBase = proposal.frontmatter.extra['supersedes_base']
  // The frontmatter parser re-types bare numbers, so accept number or numeric string.
  const baseVersion =
    typeof rawBase === 'number' && Number.isFinite(rawBase)
      ? rawBase
      : typeof rawBase === 'string' && rawBase !== '' && Number.isFinite(Number(rawBase))
        ? Number(rawBase)
        : undefined
  const targetId = originId ?? supersedesTarget
  let targetExists = false
  if (targetId !== undefined && originId === undefined) {
    try {
      getEntry(root, targetId)
      targetExists = true
    } catch {
      targetExists = false
    }
  }
  const superseding = targetId !== undefined && (originId !== undefined || targetExists)
  // D06: concurrent-divergence gate. Only local supersedes revisions (not
  // cross-hub origin upserts — those follow the central hub's own review) and
  // only when the base version is known (proposed against an existing target).
  if (superseding && originId === undefined && supersedesTarget !== undefined && baseVersion !== undefined) {
    const currentVersion = getEntry(root, supersedesTarget).frontmatter.version
    if (currentVersion > baseVersion && opts?.override !== true) {
      helpers.appendLedger(root, {
        type: 'dispute.raised',
        proposalId: proposal.id,
        targetId: supersedesTarget,
        baseVersion,
        currentVersion,
        at: new Date().toISOString(),
      })
      return {
        disputed: true,
        proposalId: proposal.id,
        targetId: supersedesTarget,
        baseVersion,
        currentVersion,
        reason: `目标 ${supersedesTarget} 已被推进到 v${currentVersion}（你的修订基于 v${baseVersion}）——分歧已隔离，未覆盖`,
        hint: '先 memhub sync pull 基于最新版重新提交修订；若确认要覆盖请带 --override（会记录 dispute.overridden 审计）',
      }
    }
    if (currentVersion > baseVersion) {
      helpers.appendLedger(root, {
        type: 'dispute.overridden',
        proposalId: proposal.id,
        targetId: supersedesTarget,
        baseVersion,
        currentVersion,
        channel: opts?.channel ?? 'human',
        at: new Date().toISOString(),
      })
    }
  }
  const committed = commitKnowledge(
    root,
    {
      ...(superseding ? { id: targetId } : {}),
      type: proposal.frontmatter.type,
      title: proposal.frontmatter.title,
      summary: proposal.frontmatter.summary,
      scope: proposal.frontmatter.scope,
      tags: proposal.frontmatter.tags,
      body: splitFrontmatter(readFileSync(proposal.path, 'utf8'))?.body ?? '',
      actor: opts?.channel ?? 'human',
    },
    helpers,
  )
  try {
    unlinkSync(proposal.path)
  } catch {
    // already gone — fine
  }
  helpers.appendLedger(root, {
    type: 'proposal.committed',
    proposalId: proposal.id,
    knowledgeId: committed.id,
    ...(superseding ? { supersedes: targetId } : {}),
    channel: opts?.channel ?? 'human',
    ...(opts?.note !== undefined ? { note: opts.note } : {}),
    at: new Date().toISOString(),
  })
  return { knowledgeId: committed.id, version: committed.version, path: committed.path, ...(superseding ? { superseded: targetId } : {}) }
}

export type CommitProposalResult =
  | {
      disputed: true
      proposalId: string
      targetId: string
      baseVersion: number
      currentVersion: number
      reason: string
      hint: string
    }
  | { disputed?: false; knowledgeId: string; version: number; path: string; superseded?: string }

/**
 * Surgically rewrite ONE frontmatter field, leaving every other byte alone.
 *
 * Why not parse+render: hubs migrated from the predecessor (dsh-memory-hub)
 * carry keys this schema does not model (`related`, `supersedes`,
 * `promoted_from`, `applies_to`, `created_at`…) and shorthand forms such as
 * `scope: project:foo`. Re-serializing the whole frontmatter normalizes those
 * away — `source_refs` block lists collapse into one long string and unknown
 * keys are re-emitted as empty arrays. A status flip must not rewrite anything
 * it was not asked to touch, so we patch the single line in place.
 */
function patchFrontmatterLine(path: string, field: string, value: string): void {
  const raw = readFileSync(path, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw)
  if (m === null) throw new HubError(ErrorCode.E_VALIDATION, `entry has no frontmatter: ${path}`, { path })
  const head = m[1] ?? '---\n'
  const fm = m[2] ?? ''
  const tail = raw.slice((m[0] ?? '').length)
  const close = m[3] ?? '\n---'
  const line = `${field}: ${value}`
  const existing = new RegExp(`^${field}:.*$`, 'm')
  const nextFm = existing.test(fm) ? fm.replace(existing, line) : `${fm}${eol}${line}`
  atomicWrite(path, `${head}${nextFm}${close}${tail}`)
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
  patchFrontmatterLine(entry.path, 'status', 'deprecated')
  helpers.appendLedger(root, {
    ts,
    actor: 'human',
    action: 'deprecate',
    id,
    version: entry.frontmatter.version,
    note: reason,
  })
}

/** Undo a deprecation: status back to accepted + ledger record. */
export function restoreEntry(
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
  patchFrontmatterLine(entry.path, 'status', 'accepted')
  helpers.appendLedger(root, {
    ts,
    actor: 'human',
    action: 'restore',
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
  // D06 arbitration: record the TARGET VERSION this revision is based on, so
  // approval can detect a concurrent advance (someone else pushed vN+1 while
  // this proposal was being written) and isolate the dispute instead of
  // silently overwriting. Absent target locally -> no base -> legacy path.
  let supersedesBase: number | undefined
  const supersedesFirst = input.supersedes?.[0]
  if (supersedesFirst !== undefined) {
    try {
      supersedesBase = getEntry(root, supersedesFirst).frontmatter.version
    } catch {
      supersedesBase = undefined
    }
  }
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
      ...(supersedesBase !== undefined ? { supersedes_base: String(supersedesBase) } : {}),
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
