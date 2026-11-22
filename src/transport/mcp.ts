import { appendFileSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCode, HubError } from '../core/errors.js'
import { isHubInitialized, readHubConfig } from '../core/hub.js'
import {
  appendLedger,
  ledgerPath,
  readSequences,
  writeSequences,
} from '../core/ledger.js'
import {
  acquireLock,
  assertFencing,
  heartbeatLock,
  lockInfo,
  releaseLock,
} from '../core/lock.js'
import { registerWorkspace, resolveWorkspace, type ResolvedWorkspace } from '../core/registry.js'
import {
  buildIndex,
  emptyMetrics,
  searchWithMetrics,
  type SearchIndex,
  type SearchMetrics,
} from '../core/search.js'
import {
  commitKnowledge,
  commitProposal,
  createProposal,
  findTitleConflict,
  getEntry,
  listProposals,
} from '../core/store.js'
import { requireApproval, type ApprovalChannel } from '../core/approval.js'
import { preflight } from '../core/inject.js'
import { appendJournal, readJournal } from '../core/journal.js'
import { detectDejaVu, indexTranscript, readTranscriptIndex } from '../core/transcript.js'
import type { KnowledgeScope, KnowledgeType } from '../core/types.js'

/**
 * MCP stdio transport — zero-dependency JSON-RPC 2.0. The protocol surface is
 * small (initialize / tools/list / tools/call), so we implement it directly
 * (dependency policy) with the same tool contract as the CLI (one behavior,
 * one implementation — tests are shared).
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const
const SERVER_INFO = { name: 'memhub', version: '0.1.0' }

export interface TransportState {
  hubRoot: string
  workspace: ResolvedWorkspace
  index: SearchIndex
  metrics: SearchMetrics
  lockToken?: string
}

export function createState(hubRoot: string, workspaceArg?: string): TransportState {
  if (!isHubInitialized(hubRoot)) {
    throw new HubError(
      ErrorCode.E_HUB_NOT_INITIALIZED,
      `hub not initialized at ${hubRoot} — run \`memhub init --root ${hubRoot}\``,
      { hubRoot },
    )
  }
  const workspace = resolveWorkspace(process.cwd(), workspaceArg)
  const index = buildIndex(hubRoot, () => new Date().toISOString())
  return { hubRoot, workspace, index, metrics: emptyMetrics(index) }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  description: string
  inputSchema: Record<string, unknown>
  handler: (state: TransportState, args: Record<string, unknown>) => unknown
}

export const TOOLS: Record<string, ToolDef> = {
  memory_search: {
    description:
      'Search accepted knowledge by keywords or a natural-language intent. Scope-filtered: the workspace sees itself + global; pass team=<teamId> (or set MEMHUB_TEAM) to see that team/domain layer. Ranked results; default detail (L1) returns summaries — pass detail=L2 only when the full body is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        team: { type: 'string', description: 'Team/domain id — without it, team-layer knowledge is invisible to search' },
        detail: { type: 'string', enum: ['L0', 'L1', 'L2'] },
        limit: { type: 'number' },
        minScore: { type: 'number' },
        types: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
    handler: (state, args) => {
      const hits = searchWithMetrics(state.index, state.metrics, String(args['query']), {
        workspaceId: state.workspace.workspaceId,
        teamId: (args['team'] as string | undefined) ?? process.env['MEMHUB_TEAM'],
        detail: (args['detail'] as 'L0' | 'L1' | 'L2' | undefined) ?? 'L1',
        limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
        minScore: typeof args['minScore'] === 'number' ? args['minScore'] : 0,
        types: args['types'] as string[] | undefined,
      })
      return {
        hits,
        workspace: workspaceStatus(state.workspace),
        metrics: metricsSnapshot(state.metrics),
      }
    },
  },
  memory_get: {
    description:
      'Read one knowledge entry by ID. Returns metadata + summary by default; pass full=true (or section=<heading>) only when the whole body is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        full: { type: 'boolean' },
        section: { type: 'string' },
      },
      required: ['id'],
    },
    handler: (state, args) => {
      const entry = getEntry(state.hubRoot, String(args['id']))
      const full = args['full'] === true
      const section = typeof args['section'] === 'string' ? args['section'] : undefined
      let body: string | undefined
      if (section !== undefined) {
        const marker = `# ${section}`
        const start = entry.body.indexOf(marker)
        body = start === -1 ? undefined : entry.body.slice(start, entry.body.indexOf('\n# ', start + 1))
      } else if (full) {
        body = entry.body
      }
      return { frontmatter: entry.frontmatter, body, path: entry.path }
    },
  },
  memory_status: {
    description:
      'Read-only self check: hub root, workspace identity (exact flag is honest — false means synthetic fallback), writer lock holder, metrics, pending count, DATA FRESHNESS (when this hub last pulled from / published to the remote). Runtime tools never need the remote — if it is down, search/propose/approve keep working; only cross-team NEW knowledge visibility pauses until the next pull.',
    inputSchema: { type: 'object', properties: {} },
    handler: (state) => ({
      hubRoot: state.hubRoot,
      initialized: true,
      workspace: workspaceStatus(state.workspace),
      lock: lockInfo(state.hubRoot),
      metrics: metricsSnapshot(state.metrics),
      proposals: listProposals(state.hubRoot).length,
      freshness: readFreshness(state.hubRoot),
    }),
  },
  memory_propose: {
    description:
      'Create a pending candidate (pending/PRO-*.md). This NEVER writes knowledge/ directly — a human must approve via the panel or `memhub inbox`. Always include sourceRefs evidence. To RE-EXTRACT an existing entry (e.g. generalize an environment-specific flow), pass supersedes: [entryId] — approval upgrades that entry\'s version instead of creating a duplicate. Pass team=<teamId> to propose into that team/domain layer (still human-approved before it lands). Pass private: true to write straight into the personal tier (knowledge-private/ — never leaves the hub, no team approval).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['decision', 'constraint', 'knowledge', 'api-catalog', 'process', 'open-questions', 'runtime-base', 'playbooks', 'assets'],
        },
        title: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        sourceRefs: { type: 'array', items: { type: 'string' } },
        team: { type: 'string', description: 'Team/domain id to propose into (else the current project workspace layer).' },
        private: { type: 'boolean', description: 'true = write straight into the personal private tier (knowledge-private/, never leaves the hub, no team approval).' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Entry id(s) this proposal re-extracts; approval upgrades their version.' },
      },
      required: ['type', 'title', 'summary', 'body'],
    },
    handler: (state, args) =>
      withWriteLock(state, () => {
        const supersedes = args['supersedes'] as string[] | undefined
        const team = (args['team'] as string | undefined) ?? process.env['MEMHUB_TEAM']
        const isPrivate = args['private'] === true
        // ADR-0023 personal tier: private memory is per-person, never leaves
        // the hub (push filters it out) and needs no TEAM approval — the
        // predecessor's "memory generated right when the task ends" depends
        // on this being a direct write, not an inbox round-trip.
        if (isPrivate) {
          const committed = commitKnowledge(
            state.hubRoot,
            {
              type: args['type'] as KnowledgeType,
              title: String(args['title']),
              summary: String(args['summary']),
              scope: { level: 'private' },
              tags: args['tags'] as string[] | undefined,
              body: String(args['body']),
              sourceRefs: (args['sourceRefs'] as string[] | undefined) ?? [],
              actor: 'model',
            },
            {
              readSequences,
              writeSequences,
              appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
            },
          )
          state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
          state.metrics = emptyMetrics(state.index)
          return {
            knowledgeId: committed.id,
            path: committed.path,
            scope: 'private',
            note: '已直写个人私有层（knowledge-private/，永不外流，无需团队审批）',
          }
        }
        const proposal = createProposal(
          state.hubRoot,
          {
            type: args['type'] as KnowledgeType,
            title: String(args['title']),
            summary: String(args['summary']),
            scope: team !== undefined && team !== '' ? { level: 'domain', domainId: team } : scopeFor(state.workspace),
            tags: args['tags'] as string[] | undefined,
            body: String(args['body']),
            sourceRefs: (args['sourceRefs'] as string[] | undefined) ?? [],
            ...(supersedes !== undefined && supersedes.length > 0 ? { supersedes } : {}),
            actor: 'model',
          },
          {
            readSequences,
            writeSequences,
            appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
          },
        )
        registerWorkspaceIfNew(state)
        return {
          proposalId: proposal.id,
          path: proposal.path,
          scope: team !== undefined && team !== '' ? `team:${team}` : 'project:current-workspace',
          nextStep: 'human approval via panel or `memhub inbox approve`',
        }
      }),
  },
  memory_commit: {
    description:
      'Move an approved candidate into knowledge/. Only a human-carried channel can pass: over MCP this tool ALWAYS fails closed with E_APPROVAL_REQUIRED — use the panel or `memhub inbox approve <ID>`.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        channel: { type: 'string' },
      },
      required: ['proposalId'],
    },
    handler: (state, args) =>
      withWriteLock(state, () => {
        const proposalId = String(args['proposalId'])
        requireApproval((args['channel'] as ApprovalChannel | undefined) ?? 'mcp-model', {
          id: proposalId,
          ledgerAppend: (record) => appendLedger(ledgerPath(state.hubRoot), record as never),
        })
        return commitFromProposal(state, proposalId)
      }),
  },
  memory_cite: {
    description:
      'Record that a knowledge entry influenced the current task (audit + aging signal). Cite after actually using an entry — search hits are not citations.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        purpose: { type: 'string' },
      },
      required: ['id', 'purpose'],
    },
    handler: (state, args) => {
      const id = String(args['id'])
      getEntry(state.hubRoot, id) // must exist
      appendLedger(ledgerPath(state.hubRoot), {
        type: 'citation.added',
        id,
        purpose: String(args['purpose']),
        at: new Date().toISOString(),
      })
      return { cited: id }
    },
  },
  memory_close_task: {
    description:
      'Close the current task with a writeback assessment (proposed / no_new_knowledge / needs_evidence / deferred). Bookkeeping only.',
    inputSchema: {
      type: 'object',
      properties: {
        assessment: { type: 'string', enum: ['proposed', 'no_new_knowledge', 'needs_evidence', 'deferred'] },
        note: { type: 'string' },
      },
      required: ['assessment'],
    },
    handler: (state, args) => {
      appendLedger(ledgerPath(state.hubRoot), {
        type: 'task.closed',
        assessment: args['assessment'],
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
        at: new Date().toISOString(),
      })
      return { closed: true }
    },
  },
  memory_duplicates: {
    description: 'Read-only near-duplicate check for a candidate title. Never writes files.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    handler: (state, args) => {
      const conflict = findTitleConflict(state.hubRoot, String(args['title']))
      return {
        conflict: conflict === null ? null : { id: conflict.frontmatter.id, title: conflict.frontmatter.title },
      }
    },
  },
  memory_preflight: {
    description:
      'Build the L0 static pack for this turn: top-3 hits (replay-calibrated), one line each, with a documented token estimate. Records a preflight.recorded event. Inject the pack only when status=ready.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        limit: { type: 'number' },
        types: { type: 'array', items: { type: 'string' } },
      },
      required: ['intent'],
    },
    handler: (state, args) => {
      const result = preflight(state.index, state.hubRoot, state.workspace.workspaceId, String(args['intent']), {
        teamId: (args['team'] as string | undefined) ?? process.env['MEMHUB_TEAM'],
        limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
        types: args['types'] as string[] | undefined,
      })
      state.metrics.queryCount += 1
      return result
    },
  },
  memory_journal: {
    description:
      'Episodic layer: append (action=append; auto-capture is fine here — journal is disposable and never becomes knowledge) or read (action=read; optional day=YYYY-MM-DD local stamp).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['append', 'read'] },
        text: { type: 'string' },
        sessionId: { type: 'string' },
        day: { type: 'string' },
      },
      required: ['action'],
    },
    handler: (state, args) => {
      const action = String(args['action'])
      if (action === 'append') {
        const text = String(args['text'] ?? '')
        if (text === '') throw new HubError(ErrorCode.E_VALIDATION, 'journal append requires text')
        return withWriteLock(state, () =>
          appendJournal(state.hubRoot, { sessionId: args['sessionId'] as string | undefined, text }),
        )
      }
      return { entries: readJournal(state.hubRoot, args['day'] as string | undefined) }
    },
  },
  memory_dejavu: {
    description:
      'Day-zero deja-vu check: was a similar conversation already had? Index a session transcript (action=index; tokens + preview only — the body stays with the host) or query overlaps (action=check).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['index', 'check'] },
        sessionId: { type: 'string' },
        text: { type: 'string' },
        location: { type: 'string' },
        query: { type: 'string' },
        threshold: { type: 'number' },
      },
      required: ['action'],
    },
    handler: (state, args) => {
      const action = String(args['action'])
      if (action === 'index') {
        const sessionId = args['sessionId'] as string | undefined
        const text = String(args['text'] ?? '')
        const location = String(args['location'] ?? '')
        if (sessionId === undefined || text === '' || location === '') {
          throw new HubError(ErrorCode.E_VALIDATION, 'dejavu index requires sessionId, text and location')
        }
        return withWriteLock(state, () => indexTranscript(state.hubRoot, { sessionId, text, location }))
      }
      const query = String(args['query'] ?? '')
      if (query === '') throw new HubError(ErrorCode.E_VALIDATION, 'dejavu check requires query')
      return {
        sessions: readTranscriptIndex(state.hubRoot).length,
        dejaVu: detectDejaVu(state.hubRoot, query, typeof args['threshold'] === 'number' ? args['threshold'] : undefined),
      }
    },
  },
}

// ---------------------------------------------------------------------------
// Write-lock + helpers
// ---------------------------------------------------------------------------

function withWriteLock(state: TransportState, fn: () => unknown): unknown {
  const acquired = acquireLock(state.hubRoot)
  if (!acquired.ok) {
    throw new HubError(ErrorCode.E_READONLY, 'another writer holds the lease (read-only for this process)', {
      holder: acquired.holder,
    })
  }
  // acquired.ok guarantees a lock with a token; '' would fail fencing loudly anyway.
  const token = acquired.lock?.token ?? ''
  state.lockToken = token
  try {
    assertFencing(state.hubRoot, token)
    return fn()
  } finally {
    releaseLock(state.hubRoot, token)
    state.lockToken = undefined
  }
}

function scopeFor(workspace: ResolvedWorkspace): KnowledgeScope {
  return { level: 'project', workspaceId: workspace.workspaceId }
}

function workspaceStatus(workspace: ResolvedWorkspace): Record<string, unknown> {
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    path: workspace.path,
    exact: workspace.exact,
    origin: workspace.origin,
  }
}

/**
 * Data freshness — lets any host's agent reason about its knowledge boundary
 * WITHOUT touching the remote: if the remote is down, everything above still
 * works; these watermarks just say how recent the cross-team view is.
 */
function readFreshness(hubRoot: string): Record<string, unknown> {
  const readWatermark = (file: string, key: string): string => {
    try {
      const raw = JSON.parse(readFileSync(join(hubRoot, 'records', file), 'utf8')) as Record<string, unknown>
      return typeof raw[key] === 'string' ? (raw[key] as string) : ''
    } catch {
      return ''
    }
  }
  const lastPullAt = readWatermark('hub-pull-state.json', 'lastPulledAt')
  const lastPublishedAt = readWatermark('publish-state.json', 'lastPublishedAt')
  const lastExtractAt = readWatermark('extract-state.json', 'lastExtractedAt')
  const stale: string[] = []
  if (lastPullAt === '') stale.push('pull: never synced from the remote — team knowledge may be missing locally')
  if (lastPublishedAt === '') stale.push('publish: never published — local approvals are not on the remote yet')
  // A synthetic hub lives in the OS temp dir: fine for a smoke test, fatal for
  // real memory (gone on reboot). Say it loudly so the agent can warn the user.
  try {
    const tmp = realpathSync(tmpdir())
    if (hubRoot.toLowerCase().startsWith(tmp.toLowerCase())) {
      stale.push('hubRoot is inside the OS temp dir — memories here are NOT persistent. Run `memhub install <host> --root <persistent-dir>` or set $MEMHUB_ROOT')
    }
  } catch {
    // tmpdir resolution failure is harmless here
  }
  return { lastPullAt, lastPublishedAt, lastExtractAt, ...(stale.length > 0 ? { notes: stale } : {}) }
}

function metricsSnapshot(metrics: SearchMetrics): Record<string, unknown> {
  const { indexedCount, queryCount, totalHits, lastHitCount, lastQuery, builtAt } = metrics
  return {
    indexedCount,
    queryCount,
    avgHits: queryCount === 0 ? 0 : Math.round((totalHits / queryCount) * 100) / 100,
    lastHitCount,
    lastQuery,
    builtAt,
  }
}

function registerWorkspaceIfNew(state: TransportState): void {
  registerWorkspace(
    state.hubRoot,
    state.workspace,
    () => new Date().toISOString(),
    readHubConfig,
    (root, content) => {
      appendFileSync(join(root, 'hub.yaml'), content, 'utf8')
    },
  )
}

function commitFromProposal(state: TransportState, proposalId: string): unknown {
  const proposal = listProposals(state.hubRoot).find((p) => p.id === proposalId)
  if (proposal === undefined) {
    throw new HubError(ErrorCode.E_NOT_FOUND, `pending proposal not found: ${proposalId}`, { proposalId })
  }
  // One shared approval implementation for every surface (store.commitProposal).
  const committed = commitProposal(
    state.hubRoot,
    proposal,
    { readSequences, writeSequences, appendLedger: (root, record) => appendLedger(ledgerPath(root), record) },
    { channel: 'panel' },
  )
  if ('disputed' in committed && committed.disputed) {
    throw new HubError(ErrorCode.E_CONFLICT, committed.reason, { hint: committed.hint, targetId: committed.targetId, baseVersion: committed.baseVersion, currentVersion: committed.currentVersion })
  }
  state.index = buildIndex(state.hubRoot, () => new Date().toISOString())
  state.metrics = emptyMetrics(state.index)
  return { knowledgeId: committed.knowledgeId, version: committed.version, path: committed.path }
}

export function heartbeat(state: TransportState): boolean {
  return state.lockToken !== undefined && heartbeatLock(state.hubRoot, state.lockToken)
}

// ---------------------------------------------------------------------------
// JSON-RPC stdio loop
// ---------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export function handleRpc(state: TransportState, line: string): string | null {
  let request: RpcRequest
  try {
    request = JSON.parse(line) as RpcRequest
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }
  const { id = null, method } = request
  if (method === undefined) return rpcError(id, -32600, 'Invalid Request')
  try {
    switch (method) {
      case 'initialize': {
        const requested = String(request.params?.['protocolVersion'] ?? '')
        const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]
        return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
      }
      case 'notifications/initialized':
        return null // notification: no response
      case 'tools/list':
        return rpcResult(id, {
          tools: Object.entries(TOOLS).map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: def.inputSchema,
          })),
        })
      case 'tools/call': {
        const name = String(request.params?.['name'] ?? '')
        const tool = TOOLS[name]
        if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`)
        const args = (request.params?.['arguments'] as Record<string, unknown> | undefined) ?? {}
        try {
          const result = tool.handler(state, args)
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
        } catch (error) {
          const detail = error instanceof HubError ? { code: error.code, details: error.details } : undefined
          const message = error instanceof Error ? error.message : String(error)
          return rpcResult(id, {
            content: [{ type: 'text', text: message }],
            isError: true,
            error: detail,
          })
        }
      }
      case 'ping':
        return rpcResult(id, {})
      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return rpcError(id, -32603, message)
  }
}

function rpcResult(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function rpcError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

/** Blocking stdio loop (server mode). Exits cleanly on EOF. */
export function serveStdio(state: TransportState): void {
  process.stdin.setEncoding('utf8')
  let data = ''
  const lines: string[] = []
  process.stdin.on('data', (chunk: string) => {
    data += chunk
    let newline = data.indexOf('\n')
    while (newline !== -1) {
      const line = data.slice(0, newline).trim()
      data = data.slice(newline + 1)
      if (line !== '') lines.push(line)
      newline = data.indexOf('\n')
    }
    while (lines.length > 0) {
      const line = lines.shift()
      if (line === undefined) break
      const response = handleRpc(state, line)
      if (response !== null) process.stdout.write(`${response}\n`)
    }
  })
  process.stdin.on('end', () => {
    process.exit(0)
  })
}
