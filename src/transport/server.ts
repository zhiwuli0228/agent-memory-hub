import { unlinkSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode, HubError } from '../core/errors.js'
import { readHubConfig } from '../core/hub.js'
import { appendLedger, ledgerPath, readSequences, writeSequences } from '../core/ledger.js'
import { acquireLock, assertFencing, lockInfo, releaseLock } from '../core/lock.js'
import { commitKnowledge, commitProposal, createProposal, deprecateEntry, getEntry, hardDeleteEntry, listEntries, listProposals, restoreEntry } from '../core/store.js'
import { buildIndex, emptyMetrics, search, type SearchIndex, type SearchMetrics } from '../core/search.js'

/**
 * ADR-0022: intake-side twin detection (proposal title vs pending queue and
 * approved corpus). CJK-bigram jaccard on title+summary, calibrated threshold
 * from ADR-0017 (verbatim twins ~0.74). Returns the existing proposal/entry id
 * when the incoming title is a twin, null when genuinely new.
 */
function analyzeIntakeDuplicates(root: string, title: string, originId?: string): string | null {
  const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
  const incoming = norm(title)
  for (const p of listProposals(root)) {
    // Same originId = a REVISED push of the same local entry (ADR-0012
    // version bump) — not a twin; let it through to the upsert flow.
    if (originId !== undefined && p.frontmatter.extra['origin_id'] === originId) continue
    if (norm(p.frontmatter.title) === incoming) return p.id
  }
  for (const e of listEntries(root)) {
    if (originId !== undefined && e.frontmatter.id === originId) continue
    if (norm(e.frontmatter.title) === incoming) return e.frontmatter.id
  }
  return null
}
import { registerWorkspace, resolveWorkspace, type ResolvedWorkspace } from '../core/registry.js'
import { readJournal } from '../core/journal.js'
import { readLedger } from '../core/ledger.js'
import { autoCommit } from './autocommit.js'
import type { KnowledgeScope, KnowledgeType } from '../core/types.js'

/**
 * Serve panel HTTP API — pure request handler (createServer is a thin
 * adapter). The panel is a human channel (panel): approving from it carries
 * real approval, unlike memory_commit over MCP.
 *
 * Graded approval: decision / constraint / api-catalog entries shape future
 * behavior, so they must be approved individually; lower-risk types may be
 * approved in batches.
 */

/** Types whose approval must be one-by-one (they constrain future behavior). */
const INDIVIDUAL_TYPES: readonly KnowledgeType[] = ['decision', 'constraint', 'api-catalog']

export type ApprovalGrade = 'individual' | 'batch'

export function gradeFor(type: KnowledgeType): ApprovalGrade {
  return INDIVIDUAL_TYPES.includes(type) ? 'individual' : 'batch'
}

export interface ApiState {
  hubRoot: string
  workspace: ResolvedWorkspace
  index: SearchIndex
  metrics: SearchMetrics
}

export function createApiState(hubRoot: string, workspaceArg?: string): ApiState {
  const workspace = resolveWorkspace(process.cwd(), workspaceArg)
  const index = buildIndex(hubRoot, () => new Date().toISOString())
  return { hubRoot, workspace, index, metrics: emptyMetrics(index) }
}

export interface ApiResponse {
  status: number
  body: unknown
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body }
}

function bad(status: number, message: string, details?: unknown): ApiResponse {
  return { status, body: { error: message, details } }
}

function withWriteLock<T>(hubRoot: string, fn: () => T): T {
  const acquired = acquireLock(hubRoot)
  if (!acquired.ok) {
    throw new HubError(ErrorCode.E_READONLY, 'another writer holds the lease', { holder: acquired.holder })
  }
  const token = acquired.lock?.token ?? ''
  try {
    assertFencing(hubRoot, token)
    return fn()
  } finally {
    releaseLock(hubRoot, token)
  }
}

function commitOne(hubRoot: string, proposalId: string, note?: string, override = false): { knowledgeId: string; version: number; superseded?: string; git: { committed: boolean; detail?: string } } {
  const proposal = listProposals(hubRoot).find((p) => p.id === proposalId)
  if (proposal === undefined) {
    throw new HubError(ErrorCode.E_NOT_FOUND, `pending proposal not found: ${proposalId}`, { proposalId })
  }
  // One shared approval implementation for every surface (store.commitProposal):
  // origin_id upsert (central side) / supersedes re-extraction, both version-bump.
  // D06: a stale-base revision is isolated as a dispute unless the caller
  // explicitly overrides (the panel asks for confirmation first).
  const committed = commitProposal(hubRoot, proposal, { readSequences, writeSequences, appendLedger: (root, record) => appendLedger(ledgerPath(root), record) }, { channel: 'panel', note, override })
  if ('disputed' in committed && committed.disputed) {
    throw new HubError(ErrorCode.E_CONFLICT, committed.reason, { hint: committed.hint, targetId: committed.targetId, baseVersion: committed.baseVersion, currentVersion: committed.currentVersion })
  }
  const gitCommit = autoCommit(hubRoot, `approve: ${committed.knowledgeId}@v${committed.version} ${proposal.frontmatter.title}`)
  return { knowledgeId: committed.knowledgeId, version: committed.version, ...(committed.superseded !== undefined ? { superseded: committed.superseded } : {}), git: gitCommit }
}

/** Route one API request. `body` is the parsed JSON body or undefined. */
export interface AuthContext {
  role: 'admin' | 'domain'
  domainId?: string
}

export function handleApi(state: ApiState, method: string, path: string, body?: Record<string, unknown>, auth?: AuthContext): ApiResponse {
  try {
    switch (`${method} ${path}`) {
      case 'GET /api/status':
        return ok({
          hubRoot: state.hubRoot,
          workspace: state.workspace,
          lock: lockInfo(state.hubRoot),
          metrics: state.metrics,
          acceptedCount: listEntries(state.hubRoot).length,
        })
      case 'GET /api/inbox': {
        // ADR-0021: large-team triage — group by domain so each domain's
        // reviewer sees their slice; ?domain= narrows to one slice.
        const domainFilter = body?.['domain']
        const proposals = listProposals(state.hubRoot).map((p) => ({
          id: p.id,
          type: p.frontmatter.type,
          title: p.frontmatter.title,
          summary: p.frontmatter.summary,
          tags: p.frontmatter.tags,
          domain: p.frontmatter.scope.level === 'domain' ? p.frontmatter.scope.domainId : null,
          grade: gradeFor(p.frontmatter.type),
          path: p.path,
        }))
        const filtered = typeof domainFilter === 'string' && domainFilter !== '' ? proposals.filter((p) => p.domain === domainFilter) : proposals
        const groups: Record<string, number> = {}
        for (const p of proposals) {
          const key = p.domain ?? '(no-domain)'
          groups[key] = (groups[key] ?? 0) + 1
        }
        return ok({ proposals: filtered, groups, total: proposals.length })
      }
      case 'GET /api/search': {
        // ADR-0018 read side: remote consumers (WeKnora-style integrations,
        // other hosts, CI) search THIS hub in real time — no snapshot pull
        // required. Open by design; only writes are gated. ?workspace=all
        // (default) searches the whole shared hub; a concrete workspace id
        // narrows visibility to that project's scope.
        const query = String(body?.['q'] ?? body?.['query'] ?? '')
        if (query === '') return { status: 400, body: { error: 'missing ?q=' } }
        const detail = (body?.['detail'] === 'L0' || body?.['detail'] === 'L1' || body?.['detail'] === 'L2' ? body['detail'] : 'L1') as 'L0' | 'L1' | 'L2'
        const limitNum = Number(body?.['limit'])
        const wsRaw = body?.['workspace']
        const workspaceId = wsRaw === undefined || wsRaw === 'all' || wsRaw === '' ? undefined : String(wsRaw)
        // ADR-0019: the caller declares its access scope — a project and/or a
        // team domain. Visibility = global ∪ declared team ∪ declared project.
        const teamRaw = body?.['team']
        const teamId = teamRaw === undefined || teamRaw === '' ? undefined : String(teamRaw)
        const hits = search(state.index, query, {
          workspaceId,
          teamId,
          detail,
          limit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined,
        })
        return ok({ query, workspace: workspaceId ?? (teamId !== undefined ? `team:${teamId}` : 'all'), hits })
      }
      case 'POST /api/propose': {
        // ADR-0012: remote hubs push their approved entries here as proposals —
        // this inbox IS the central review (approve = merge, reject = declined).
        // originId keeps the source hub's entry id so approval upserts in place.
        const type = body?.['type']
        const title = body?.['title']
        const summary = body?.['summary']
        const bodyText = body?.['body']
        if (typeof type !== 'string' || typeof title !== 'string' || typeof summary !== 'string' || typeof bodyText !== 'string') {
          return bad(400, 'propose requires type, title, summary, body')
        }
        // ADR-0019: the pushed entry's scope travels with it (team domains
        // especially). Validate the shape; fall back to the receiving hub's
        // project scope when absent/invalid.
        // ADR-0021: a domain token IS the pusher's team identity. The token
        // binds the proposal to that domain — explicit cross-domain pushes
        // are rejected, unset domains are stamped with the token's domain.
        // The admin key may push anywhere.
        if (auth?.role === 'domain') {
          const raw = body?.['scope'] as { level?: string; domainId?: string } | undefined
          if (raw?.level === 'domain' && raw.domainId !== auth.domainId) {
            return bad(403, `token is bound to domain ${auth.domainId} — cannot push into ${String(raw.domainId)}`)
          }
          if (raw?.level !== 'domain') body!['scope'] = { level: 'domain', domainId: auth.domainId }
        }
        const rawScope = body?.['scope'] as { level?: string; domainId?: string; workspaceId?: string } | undefined
        if (rawScope?.level === 'private') {
          // ADR-0020: private entries never leave their hub — reject, not rewrite.
          return bad(400, 'private entries never leave their hub (keep them local or change the scope)')
        }
        let scope: KnowledgeScope = { level: 'project', workspaceId: state.workspace.workspaceId }
        if (rawScope?.level === 'global') scope = { level: 'global' }
        else if (rawScope?.level === 'domain' && typeof rawScope.domainId === 'string' && rawScope.domainId !== '') scope = { level: 'domain', domainId: rawScope.domainId }
        else if (rawScope?.level === 'project' && typeof rawScope.workspaceId === 'string' && rawScope.workspaceId !== '') scope = { level: 'project', workspaceId: rawScope.workspaceId }
        // ADR-0022 inbox intake dedup: 150 people pushing daily batches WILL
        // record the same pitfall — a twin of an existing pending proposal or
        // approved entry is returned as `duplicate: true` (no new proposal),
        // so review bandwidth is spent on new knowledge only.
        const intake = analyzeIntakeDuplicates(state.hubRoot, title, typeof body?.['originId'] === 'string' ? body['originId'] : undefined)
        if (intake !== null) {
          return ok({ proposalId: intake, duplicate: true, nextStep: 'duplicate content — your push matched an existing proposal; nothing new to review' })
        }
        return withWriteLock(state.hubRoot, () => {
          const proposal = createProposal(
            state.hubRoot,
            {
              type: type as KnowledgeType,
              title,
              summary,
              scope,
              tags: Array.isArray(body?.['tags']) ? (body?.['tags'] as string[]).map(String) : [],
              body: bodyText,
              sourceRefs: Array.isArray(body?.['sourceRefs']) ? (body?.['sourceRefs'] as string[]).map(String) : [`remote:${new Date().toISOString()}`],
              supersedes: Array.isArray(body?.['supersedes']) ? (body?.['supersedes'] as string[]).map(String) : undefined,
              originId: typeof body?.['originId'] === 'string' ? body['originId'] : undefined,
              origin: typeof body?.['origin'] === 'string' ? body['origin'] : 'remote-hub',
              actor: 'remote',
            },
            { readSequences, writeSequences, appendLedger: (root, record) => appendLedger(ledgerPath(root), record) },
          )
          registerWorkspace(
            state.hubRoot,
            state.workspace,
            () => new Date().toISOString(),
            readHubConfig,
            (root, content) => {
              appendFileSync(join(root, 'hub.yaml'), content, 'utf8')
            },
          )
          state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
          state.metrics = emptyMetrics(state.index)
          return ok({ proposalId: proposal.id, nextStep: 'central review via inbox' })
        })
      }
      case 'POST /api/search': {
        const query = String(body?.['query'] ?? '')
        if (query === '') return bad(400, 'query is required')
        const hits = search(state.index, query, {
          workspaceId: state.workspace.workspaceId,
          detail: 'L1',
          limit: typeof body?.['limit'] === 'number' ? body['limit'] : 10,
        })
        return ok({ hits })
      }
      case 'GET /api/entries': {
        const since = typeof body?.['since'] === 'string' ? body['since'] : undefined
        const all = listEntries(state.hubRoot, { includeSoftRemoved: true }).map((e) => ({
          id: e.frontmatter.id,
          version: e.frontmatter.version,
          type: e.frontmatter.type,
          status: e.frontmatter.status,
          title: e.frontmatter.title,
          summary: e.frontmatter.summary,
          scope: e.frontmatter.scope,
          tags: e.frontmatter.tags,
          updated: e.frontmatter.updated,
          path: e.path,
        }))
        // ADR-0012: `since` enables incremental hub pull (updated > since).
        const entries = since === undefined ? all : all.filter((e) => (e.updated ?? '') > since)
        return ok({ entries, since: since ?? null, count: entries.length })
      }
      case 'GET /api/ledger': {
        const records = readLedger(ledgerPath(state.hubRoot))
        const limit = typeof body?.['limit'] === 'number' ? body['limit'] : 200
        return ok({ records: records.slice(-limit).reverse(), total: records.length })
      }
      case 'GET /api/journal': {
        const day = typeof body?.['day'] === 'string' ? body['day'] : undefined
        const entries = readJournal(state.hubRoot, day)
        return ok({ entries: entries.slice(-200).reverse() })
      }
      default:
        break
    }
    const approveMatch = /^\/api\/inbox\/([A-Za-z0-9-]+)\/approve$/.exec(path)
    if (approveMatch !== null && method === 'POST') {
      return approve(state, [approveMatch[1] ?? ''], body)
    }
    const batchMatch = /^\/api\/inbox\/approve$/.exec(path)
    if (batchMatch !== null && method === 'POST') {
      const ids = body?.['ids']
      if (!Array.isArray(ids) || ids.length === 0) return bad(400, 'ids array is required for batch approval')
      return approve(state, ids.map(String), body)
    }
    const rejectMatch = /^\/api\/inbox\/([A-Za-z0-9-]+)\/reject$/.exec(path)
    if (rejectMatch !== null && method === 'POST') {
      return reject(state, rejectMatch[1] ?? '', body)
    }
    const entryMatch = /^\/api\/entries\/([A-Za-z0-9-]+)$/.exec(path)
    if (entryMatch !== null && method === 'GET') {
      const entry = getEntry(state.hubRoot, entryMatch[1] ?? '')
      return ok({ frontmatter: entry.frontmatter, body: entry.body, path: entry.path })
    }
    const deprecateMatch = /^\/api\/entries\/([A-Za-z0-9-]+)\/deprecate$/.exec(path)
    if (deprecateMatch !== null && method === 'POST') {
      const reason = typeof body?.['reason'] === 'string' && body['reason'] !== '' ? body['reason'] : 'deprecated via panel'
      return withWriteLock(state.hubRoot, () => {
        deprecateEntry(state.hubRoot, deprecateMatch[1] ?? '', reason, {
          appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
        })
        state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
        state.metrics = emptyMetrics(state.index)
        return ok({ deprecated: deprecateMatch[1] ?? '', reason, git: autoCommit(state.hubRoot, `deprecate: ${deprecateMatch[1]} (${reason})`) })
      })
    }
    const restoreMatch = /^\/api\/entries\/([A-Za-z0-9-]+)\/restore$/.exec(path)
    if (restoreMatch !== null && method === 'POST') {
      const reason = typeof body?.['reason'] === 'string' && body['reason'] !== '' ? body['reason'] : 'restored via panel'
      return withWriteLock(state.hubRoot, () => {
        restoreEntry(state.hubRoot, restoreMatch[1] ?? '', reason, {
          appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
        })
        state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
        state.metrics = emptyMetrics(state.index)
        return ok({ restored: restoreMatch[1] ?? '', reason, git: autoCommit(state.hubRoot, `restore: ${restoreMatch[1]} (${reason})`) })
      })
    }
    const deleteMatch = /^\/api\/entries\/([A-Za-z0-9-]+)\/delete$/.exec(path)
    if (deleteMatch !== null && method === 'POST') {
      const reason = typeof body?.['reason'] === 'string' && body['reason'] !== '' ? body['reason'] : 'hard-deleted via panel'
      return withWriteLock(state.hubRoot, () => {
        hardDeleteEntry(state.hubRoot, deleteMatch[1] ?? '', reason, {
          appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
        })
        state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
        state.metrics = emptyMetrics(state.index)
        return ok({ deleted: deleteMatch[1] ?? '', reason, git: autoCommit(state.hubRoot, `delete: ${deleteMatch[1]} (${reason})`) })
      })
    }
    const updateMatch = /^\/api\/entries\/([A-Za-z0-9-]+)\/update$/.exec(path)
    if (updateMatch !== null && method === 'POST') {
      const existing = getEntry(state.hubRoot, updateMatch[1] ?? '')
      const summary = typeof body?.['summary'] === 'string' && body['summary'] !== '' ? body['summary'] : existing.frontmatter.summary
      const nextBody = typeof body?.['body'] === 'string' ? body['body'] : existing.body
      const tags = Array.isArray(body?.['tags']) ? (body?.['tags'] as string[]).map(String) : existing.frontmatter.tags
      return withWriteLock(state.hubRoot, () => {
        const updated = commitKnowledge(
          state.hubRoot,
          {
            id: existing.frontmatter.id,
            type: existing.frontmatter.type,
            title: existing.frontmatter.title,
            summary,
            scope: existing.frontmatter.scope,
            tags,
            body: nextBody,
            actor: 'panel',
          },
          { readSequences, writeSequences, appendLedger: (root, record) => appendLedger(ledgerPath(root), record) },
        )
        state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
        state.metrics = emptyMetrics(state.index)
        return ok({ updated: updated.id, version: updated.version, git: autoCommit(state.hubRoot, `update: ${updated.id}@v${updated.version}`) })
      })
    }
    return bad(404, `no route: ${method} ${path}`)
  } catch (error) {
    if (error instanceof HubError) {
      const map: Record<string, number> = {
        [ErrorCode.E_NOT_FOUND]: 404,
        [ErrorCode.E_VALIDATION]: 400,
        [ErrorCode.E_CONFLICT]: 409,
        [ErrorCode.E_READONLY]: 423,
        [ErrorCode.E_APPROVAL_REQUIRED]: 403,
        [ErrorCode.E_HUB_NOT_INITIALIZED]: 404,
      }
      return bad(map[error.code] ?? 500, error.message, error.details)
    }
    return bad(500, error instanceof Error ? error.message : String(error))
  }
}

function approve(state: ApiState, ids: string[], body?: Record<string, unknown>): ApiResponse {
  if (ids.length > 1) {
    // Graded approval: batch only when every id is a batch-grade type.
    const proposals = listProposals(state.hubRoot)
    const types = ids.map((id) => proposals.find((p) => p.id === id)?.frontmatter.type)
    if (types.some((t) => t === undefined)) return bad(404, 'unknown proposal id in batch')
    if (types.some((t) => gradeFor(t as KnowledgeType) === 'individual')) {
      return bad(403, 'decision/constraint/api-catalog must be approved individually (graded approval)', {
        individualTypes: INDIVIDUAL_TYPES,
      })
    }
  }
  const note = typeof body?.['note'] === 'string' ? body['note'] : undefined
  const override = body?.['override'] === true
  return withWriteLock(state.hubRoot, () => {
    const results: Array<{ proposalId: string; knowledgeId?: string; version?: number; superseded?: string; git?: { committed: boolean; detail?: string }; error?: string }> = []
    let firstError: HubError | null = null
    for (const id of ids) {
      try {
        const committed = commitOne(state.hubRoot, id, note, override)
        results.push({ proposalId: id, knowledgeId: committed.knowledgeId, version: committed.version, ...(committed.superseded !== undefined ? { superseded: committed.superseded } : {}), git: committed.git })
      } catch (error) {
        if (error instanceof HubError && firstError === null) firstError = error
        results.push({ proposalId: id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // Single-id approval surfaces the real status (404 for unknown id, etc.);
    // batches report partial success as 207.
    if (ids.length === 1 && firstError !== null) {
      return bad(httpStatusFor(firstError), firstError.message, firstError.details)
    }
    // Refresh the index so the panel search sees new entries.
    state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
    state.metrics = emptyMetrics(state.index)
    const failed = results.some((r) => r.error !== undefined)
    return { status: failed ? 207 : 200, body: { results } }
  })
}

function httpStatusFor(error: HubError): number {
  const map: Record<string, number> = {
    [ErrorCode.E_NOT_FOUND]: 404,
    [ErrorCode.E_VALIDATION]: 400,
    [ErrorCode.E_CONFLICT]: 409,
    [ErrorCode.E_READONLY]: 423,
    [ErrorCode.E_APPROVAL_REQUIRED]: 403,
    [ErrorCode.E_HUB_NOT_INITIALIZED]: 404,
  }
  return map[error.code] ?? 500
}

function reject(state: ApiState, id: string, body?: Record<string, unknown>): ApiResponse {
  const proposal = listProposals(state.hubRoot).find((p) => p.id === id)
  if (proposal === undefined) return bad(404, `pending proposal not found: ${id}`)
  const note = typeof body?.['note'] === 'string' ? body['note'] : undefined
  appendLedger(ledgerPath(state.hubRoot), {
    type: 'proposal.rejected',
    proposalId: id,
    channel: 'panel',
    note,
    at: new Date().toISOString(),
  })
  unlinkSync(proposal.path)
  return ok({ rejected: id })
}

// Re-export for the server adapter + CLI.
export { getEntry, listEntries, readLedger, readJournal, readHubConfig }
