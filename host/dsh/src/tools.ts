import * as hub from 'agent-memory-hub'
import { renderJson, resolveHubRoot, type AdapterConfig, type HostContext, type ToolDefinition } from './host-types.js'

/**
 * Tool shells: one behavior, one implementation. Every tool is a thin forward
 * to agent-memory-hub core. There is deliberately NO memory_commit tool here:
 * commits enter knowledge/ only through the human channels (`memhub inbox`
 * / the serve panel) — the fail-closed gate stays closed inside the host.
 *
 * Host contract (dsh 0.2.x): every tool must declare
 * `output { schema, render }` and expose `isConcurrencySafe()` as a method.
 */

interface HubContext {
  root: string
  workspace: hub.ResolvedWorkspace
  index: hub.SearchIndex
  metrics: hub.SearchMetrics
}

export function createHubContext(config?: AdapterConfig): HubContext {
  const root = resolveHubRoot(config)
  const workspace = hub.resolveWorkspace(process.cwd())
  const index = hub.preflightIndex(root)
  return { root, workspace, index, metrics: hub.emptyMetrics(index) }
}

function refreshIndex(ctx: HubContext): void {
  ctx.index = hub.preflightIndex(ctx.root)
  ctx.metrics = hub.emptyMetrics(ctx.index)
}

function errorPayload(error: unknown): { error: string; code?: string } {
  if (error instanceof hub.HubError) return { error: error.message, code: error.code }
  return { error: error instanceof Error ? error.message : String(error) }
}

async function safe(tool: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await tool.execute(args, undefined)
  } catch (error) {
    return errorPayload(error)
  }
}

export function createTools(ctx: HubContext): Array<ToolDefinition & { run: (args: Record<string, unknown>) => Promise<unknown> }> {
  const definitions: Array<ToolDefinition & { run: (args: Record<string, unknown>) => Promise<unknown> }> = []

  const define = (tool: Omit<ToolDefinition, 'execute' | 'output' | 'isConcurrencySafe'> & {
    execute: ToolDefinition['execute']
    concurrencySafe?: boolean
  }) => {
    definitions.push({
      ...tool,
      output: { schema: {}, render: renderJson },
      ...(tool.concurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
      run: (args: Record<string, unknown>) => safe({ ...tool, execute: tool.execute } as ToolDefinition, args),
    } as ToolDefinition & { run: (args: Record<string, unknown>) => Promise<unknown> })
  }

  define({
    name: 'memory_search',
    description:
      "Search the user's accepted long-term memory (workspace + global). Use it before planning or modifying a project, and after a preflight hint points at an entry. Returns ranked hits with summaries; call memory_get for the body and memory_cite after actually using an entry.",
    concurrencySafe: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a natural-language question.' },
        detail: { type: 'string', enum: ['L0', 'L1', 'L2'], description: 'L0 abstract only; L1 adds summary; L2 adds body.' },
        limit: { type: 'number' },
        types: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
    execute: (args) => {
      const hits = hub.searchWithMetrics(ctx.index, ctx.metrics, String(args['query']), {
        workspaceId: ctx.workspace.workspaceId,
        detail: (args['detail'] as hub.DetailLevel | undefined) ?? 'L1',
        limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
        types: args['types'] as string[] | undefined,
      })
      return {
        hits: hits.map((hit) => ({
          id: hit.id,
          version: hit.version,
          type: hit.type,
          title: hit.title,
          abstract: hit.abstract,
          ...(hit.summary !== undefined ? { summary: hit.summary } : {}),
          score: hit.score,
        })),
        workspace: ctx.workspace.workspaceId,
        exact: ctx.workspace.exact,
      }
    },
  })

  define({
    name: 'memory_get',
    description:
      'Read one knowledge entry by ID. Returns metadata + summary by default; pass full=true only when the whole body is needed.',
    concurrencySafe: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        full: { type: 'boolean' },
      },
      required: ['id'],
    },
    execute: (args) => {
      const entry = hub.getEntry(ctx.root, String(args['id']))
      // Host output contract is lossless JSON: never emit explicit `undefined`
      // property values — omit the key instead.
      return {
        frontmatter: entry.frontmatter,
        ...(args['full'] === true ? { body: entry.body } : {}),
        path: entry.path,
      }
    },
  })

  define({
    name: 'memory_status',
    description:
      'Read-only self check: hub root, workspace identity (exact=false means synthetic fallback), writer lock holder, metrics, counts.',
    concurrencySafe: true,
    parameters: { type: 'object', properties: {} },
    execute: () => ({
      hubRoot: ctx.root,
      initialized: hub.isHubInitialized(ctx.root),
      workspace: ctx.workspace,
      lock: hub.lockInfo(ctx.root),
      metrics: ctx.metrics,
      acceptedCount: hub.listEntries(ctx.root).length,
      pendingCount: hub.listProposals(ctx.root).length,
    }),
  })

  define({
    name: 'memory_preflight',
    description:
      'Build the L0 static pack for this turn: top-3 hits, one line each, with a token estimate. Records a preflight.recorded event. Inject the pack only when status=ready.',
    concurrencySafe: true,
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['intent'],
    },
    execute: (args) =>
      hub.preflight(ctx.index, ctx.root, ctx.workspace.workspaceId, String(args['intent']), {
        limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
      }),
  })

  define({
    name: 'memory_propose',
    description:
      'Create a pending candidate (pending/PRO-*.md). This NEVER writes knowledge/ directly — a human must approve via the serve panel or `memhub inbox`. Always include sourceRefs evidence.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['decision', 'constraint', 'knowledge', 'api-catalog', 'process', 'open-questions', 'runtime-base', 'playbooks', 'assets'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        sourceRefs: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'title', 'summary', 'body'],
    },
    execute: (args) => {
      const acquired = hub.acquireLock(ctx.root)
      if (!acquired.ok) return { error: 'another writer holds the lease', code: hub.ErrorCode.E_READONLY }
      const token = acquired.lock?.token ?? ''
      try {
        hub.assertFencing(ctx.root, token)
        const proposal = hub.createProposal(
          ctx.root,
          {
            type: args['type'] as hub.KnowledgeType,
            title: String(args['title']),
            summary: String(args['summary']),
            scope: { level: 'project', workspaceId: ctx.workspace.workspaceId },
            tags: args['tags'] as string[] | undefined,
            body: String(args['body']),
            sourceRefs: (args['sourceRefs'] as string[] | undefined) ?? [],
            actor: 'model',
          },
          {
            readSequences: hub.readSequences,
            writeSequences: hub.writeSequences,
            appendLedger: (root, record) => hub.appendLedger(hub.ledgerPath(root), record),
          },
        )
        return { proposalId: proposal.id, path: proposal.path, nextStep: 'human approval via panel or `memhub inbox approve`' }
      } finally {
        hub.releaseLock(ctx.root, token)
      }
    },
  })

  define({
    name: 'memory_cite',
    description:
      'Record that a knowledge entry influenced the current task (audit + aging signal). Cite after actually using an entry — search hits are not citations.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        purpose: { type: 'string' },
      },
      required: ['id', 'purpose'],
    },
    execute: (args) => {
      const id = String(args['id'])
      hub.getEntry(ctx.root, id) // must exist
      hub.appendLedger(hub.ledgerPath(ctx.root), {
        type: 'citation.added',
        id,
        purpose: String(args['purpose']),
        at: new Date().toISOString(),
      })
      return { cited: id }
    },
  })

  define({
    name: 'memory_close_task',
    description:
      'Close the current task with a writeback assessment (proposed / no_new_knowledge / needs_evidence / deferred). Bookkeeping only.',
    parameters: {
      type: 'object',
      properties: {
        assessment: { type: 'string', enum: ['proposed', 'no_new_knowledge', 'needs_evidence', 'deferred'] },
        note: { type: 'string' },
      },
      required: ['assessment'],
    },
    execute: (args) => {
      hub.appendLedger(hub.ledgerPath(ctx.root), {
        type: 'task.closed',
        assessment: args['assessment'],
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
        at: new Date().toISOString(),
      })
      return { closed: true }
    },
  })

  define({
    name: 'memory_dejavu',
    description:
      'Day-zero deja-vu check: has a similar conversation already happened? Index a transcript (action=index; tokens + preview only — the body stays with the host) or query overlaps (action=check).',
    concurrencySafe: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['index', 'check'] },
        sessionId: { type: 'string' },
        text: { type: 'string' },
        location: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['action'],
    },
    execute: (args) => {
      const action = String(args['action'])
      if (action === 'index') {
        const sessionId = args['sessionId'] as string | undefined
        const text = String(args['text'] ?? '')
        const location = String(args['location'] ?? '')
        if (sessionId === undefined || text === '' || location === '') {
          throw new hub.HubError(hub.ErrorCode.E_VALIDATION, 'dejavu index requires sessionId, text and location')
        }
        return hub.indexTranscript(ctx.root, { sessionId, text, location })
      }
      return {
        sessions: hub.readTranscriptIndex(ctx.root).length,
        dejaVu: hub.detectDejaVu(ctx.root, String(args['query'] ?? '')),
      }
    },
  })

  return definitions
}

export { refreshIndex, resolveHubRoot, type HostContext }
