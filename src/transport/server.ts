import { readFileSync, unlinkSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode, HubError } from '../core/errors.js'
import { readHubConfig } from '../core/hub.js'
import { appendLedger, ledgerPath, readSequences, writeSequences } from '../core/ledger.js'
import { acquireLock, assertFencing, lockInfo, releaseLock } from '../core/lock.js'
import { commitKnowledge, createProposal, deprecateEntry, getEntry, hardDeleteEntry, listEntries, listProposals } from '../core/store.js'
import { buildIndex, emptyMetrics, search, type SearchIndex, type SearchMetrics } from '../core/search.js'
import { registerWorkspace, resolveWorkspace, type ResolvedWorkspace } from '../core/registry.js'
import { readJournal } from '../core/journal.js'
import { readLedger } from '../core/ledger.js'
import { autoCommit } from './autocommit.js'
import type { KnowledgeType } from '../core/types.js'

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

function commitOne(hubRoot: string, proposalId: string, note?: string): { knowledgeId: string; version: number; superseded?: string; git: { committed: boolean; detail?: string } } {
  const proposal = listProposals(hubRoot).find((p) => p.id === proposalId)
  if (proposal === undefined) {
    throw new HubError(ErrorCode.E_NOT_FOUND, `pending proposal not found: ${proposalId}`, { proposalId })
  }
  // Target selection (ADR-0012): a proposal carrying origin_id upserts that
  // entry in place (create with the same id when the central hub has never
  // seen it; version bump when it has). A legacy `supersedes` still works
  // for local re-extraction proposals, and requires the target to exist.
  const rawOriginId = proposal.frontmatter.extra['origin_id']
  const originId = typeof rawOriginId === 'string' && rawOriginId !== '' && rawOriginId !== '[]' ? rawOriginId : undefined
  const rawSupersedes = proposal.frontmatter.extra['supersedes']
  const supersedesTarget = typeof rawSupersedes === 'string' && rawSupersedes !== '' && rawSupersedes !== '[]' ? rawSupersedes.split(/\s+/)[0] : undefined
  const targetId = originId ?? supersedesTarget
  const superseding = targetId !== undefined && (originId !== undefined || existsSyncSafe(hubRoot, targetId))
  const committed = commitKnowledge(
    hubRoot,
    {
      ...(superseding ? { id: targetId } : {}),
      type: proposal.frontmatter.type,
      title: proposal.frontmatter.title,
      summary: proposal.frontmatter.summary,
      scope: proposal.frontmatter.scope,
      tags: proposal.frontmatter.tags,
      body: readFileSync(proposal.path, 'utf8').split('---')[2]?.trim() ?? '',
      actor: 'panel',
    },
    { readSequences, writeSequences, appendLedger: (root, record) => appendLedger(ledgerPath(root), record) },
  )
  unlinkSync(proposal.path)
  appendLedger(ledgerPath(hubRoot), {
    type: 'proposal.committed',
    proposalId,
    knowledgeId: committed.id,
    ...(superseding ? { supersedes: targetId } : {}),
    channel: 'panel',
    note,
    at: new Date().toISOString(),
  })
  const gitCommit = autoCommit(hubRoot, `approve: ${committed.id}@v${committed.version} ${proposal.frontmatter.title}`)
  return { knowledgeId: committed.id, version: committed.version, ...(superseding ? { superseded: targetId } : {}), git: gitCommit }
}

function existsSyncSafe(hubRoot: string, id: string): boolean {
  try {
    getEntry(hubRoot, id)
    return true
  } catch {
    return false
  }
}

/** Route one API request. `body` is the parsed JSON body or undefined. */
export function handleApi(state: ApiState, method: string, path: string, body?: Record<string, unknown>): ApiResponse {
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
      case 'GET /api/inbox':
        return ok({
          proposals: listProposals(state.hubRoot).map((p) => ({
            id: p.id,
            type: p.frontmatter.type,
            title: p.frontmatter.title,
            summary: p.frontmatter.summary,
            tags: p.frontmatter.tags,
            grade: gradeFor(p.frontmatter.type),
            path: p.path,
          })),
        })
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
        return withWriteLock(state.hubRoot, () => {
          const proposal = createProposal(
            state.hubRoot,
            {
              type: type as KnowledgeType,
              title,
              summary,
              scope: { level: 'project', workspaceId: state.workspace.workspaceId },
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
  return withWriteLock(state.hubRoot, () => {
    const results: Array<{ proposalId: string; knowledgeId?: string; version?: number; superseded?: string; git?: { committed: boolean; detail?: string }; error?: string }> = []
    let firstError: HubError | null = null
    for (const id of ids) {
      try {
        const committed = commitOne(state.hubRoot, id, note)
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
