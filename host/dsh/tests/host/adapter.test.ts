import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, name as adapterName } from '../../src/index.js'
import { createHubContext, createTools } from '../../src/tools.js'
import { initHub } from 'agent-memory-hub'
import type { HostContext, ToolDefinition } from '../../src/host-types.js'

interface RegisteredHost {
  ctx: HostContext
  tools: Map<string, ToolDefinition>
  logs: string[]
  renderSnapshot(): string
}

function mockHost(): RegisteredHost {
  const tools = new Map<string, ToolDefinition>()
  const logs: string[] = []
  type SnapshotText = (context: { agent?: { session?: { header?: { cwd?: string } } } }) => string
  let promptText: SnapshotText | undefined
  const ctx: HostContext = {
    tools: {
      get: (toolName) => tools.get(toolName),
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
    },
    effect: (dispose) => {
      void dispose
    },
    systemPrompt: {
      context: (options) => {
        promptText = options.text
        return () => {
          promptText = undefined
        }
      },
    },
  }
  return {
    ctx,
    tools,
    logs,
    renderSnapshot: () => {
      if (promptText === undefined) throw new Error('snapshot text provider not registered')
      return promptText({ agent: { session: { header: { cwd: process.cwd() } } } })
    },
  }
}

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-dsh-'))
  initHub(root)
  return root
}

/** Host output contract: tool values must be lossless JSON — no undefined
 * values anywhere in the tree (the dsh host rejects them outright). */
function assertLossless(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`undefined value at ${path}`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`non-finite number at ${path}`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLossless(item, `${path}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) {
    assertLossless(item, `${path}.${key}`)
  }
}

describe('DSH adapter registration', () => {
  it('registers the memory tools on a healthy hub', () => {
    const root = seededRoot()
    process.chdir(root)
    const host = mockHost()
    apply(host.ctx, { root })
    expect(host.tools.has('memory_search')).toBe(true)
    expect(host.tools.has('memory_propose')).toBe(true)
    expect(host.tools.has('memory_preflight')).toBe(true)
    expect(host.tools.has('memory_dejavu')).toBe(true)
    // Fail-closed: there is deliberately NO memory_commit tool in the host.
    expect(host.tools.has('memory_commit')).toBe(false)
    expect(host.logs.some((log) => log.includes('registered'))).toBe(true)
    expect(adapterName).toBe('agent-memory-hub-dsh')
  })

  it('disables itself with a warning when the hub is not initialized', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-dsh-empty-'))
    process.chdir(root)
    const host = mockHost()
    apply(host.ctx, { root })
    expect(host.tools.size).toBe(0)
    expect(host.logs.some((log) => log.includes('not initialized'))).toBe(true)
  })

  it('toolConflict=skip keeps the existing registration (predecessor coexistence)', () => {
    const root = seededRoot()
    process.chdir(root)
    const host = mockHost()
    host.tools.set('memory_search', {
      name: 'memory_search',
      description: 'predecessor tool',
      parameters: {},
      output: { schema: {}, render: () => [{ type: 'text' as const, text: '' }] },
      execute: () => ({}),
    })
    apply(host.ctx, { root, toolConflict: 'skip' })
    // The predecessor's memory_search survives untouched.
    expect(host.tools.get('memory_search')?.description).toBe('predecessor tool')
    // Ours land only for non-conflicting names.
    expect(host.tools.has('memory_preflight')).toBe(true)
    expect(host.logs.some((log) => log.includes('skipping'))).toBe(true)
  })

  it('toolConflict=suffix renames ours to <name>__amh', () => {
    const root = seededRoot()
    process.chdir(root)
    const host = mockHost()
    host.tools.set('memory_search', {
      name: 'memory_search',
      description: 'predecessor tool',
      parameters: {},
      output: { schema: {}, render: () => [{ type: 'text' as const, text: '' }] },
      execute: () => ({}),
    })
    apply(host.ctx, { root, toolConflict: 'suffix' })
    expect(host.tools.get('memory_search')?.description).toBe('predecessor tool')
    expect(host.tools.has('memory_search__amh')).toBe(true)
  })

  it('tool shells execute against real core (propose -> inbox-visible)', async () => {
    const root = seededRoot()
    process.chdir(root)
    const hubCtx = createHubContext({ root })
    const tools = createTools(hubCtx)
    const propose = tools.find((tool) => tool.name === 'memory_propose')
    expect(propose).toBeDefined()
    const result = (await propose!.run({
      type: 'decision',
      title: '适配器冒烟决策',
      summary: '薄包转发 core',
      body: '正文',
      sourceRefs: ['note:adapter'],
    })) as { proposalId?: string; pendingCount?: number; error?: string }
    expect(result.proposalId).toBe('PRO-000001')
    expect(result.pendingCount).toBe(1)
    const search = tools.find((tool) => tool.name === 'memory_search')
    const hits = (await search!.run({ query: '适配器' })) as { hits: unknown[] }
    // Proposals are pending, not searchable — correct.
    expect(hits.hits).toHaveLength(0)
  })

  it('approval reminder: close_task surfaces the pending count + hint', async () => {
    const root = seededRoot()
    process.chdir(root)
    const hubCtx = createHubContext({ root })
    const tools = createTools(hubCtx)
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find((candidate) => candidate.name === name)!
      return (await tool.run(args)) as Record<string, unknown>
    }
    await run('memory_propose', { type: 'knowledge', title: '待审条目', summary: '等待人工', body: '正文', sourceRefs: ['n'] })
    const closed = await run('memory_close_task', { assessment: 'deferred' })
    expect(closed.pendingCount).toBe(1)
    expect(String(closed.hint ?? '')).toContain('待人工审批')
    // Once a human approves (the host has no memory_commit — fail-closed), the
    // reminder goes quiet.
    const { listProposals, commitProposal } = await import('agent-memory-hub')
    const proposal = listProposals(root).find((p) => p.id === 'PRO-000001')!
    const committed = commitProposal(root, proposal, {
      readSequences: (r) => JSON.parse(readFileSync(join(r, 'records', 'sequences.json'), 'utf8')),
      writeSequences: (r, seq) => writeFileSync(join(r, 'records', 'sequences.json'), JSON.stringify(seq)),
      appendLedger: (r, rec) => appendFileSync(join(r, 'records', 'ledger.jsonl'), `${JSON.stringify(rec)}\n`),
    }, { channel: 'panel' })
    if ('disputed' in committed && committed.disputed) throw new Error('unexpected dispute')
    expect(committed.knowledgeId).toBe('KNO-000001')
    const closed2 = await run('memory_close_task', { assessment: 'no_new_knowledge' })
    expect(closed2.pendingCount).toBe(0)
  })

  it('approval reminder: the session snapshot lists the waiting proposal count', () => {
    const root = seededRoot()
    process.chdir(root)
    const host = mockHost()
    apply(host.ctx, { root })
    // No pending proposals yet: the snapshot must not nag.
    expect(host.renderSnapshot()).not.toContain('待审批')
    const hubCtx = createHubContext({ root })
    const tools = createTools(hubCtx)
    const propose = tools.find((tool) => tool.name === 'memory_propose')!
    void propose.run({ type: 'knowledge', title: '快照待审条目', summary: 's', body: 'b', sourceRefs: ['n'] })
    // Throttle is 30s; force a fresh render by waiting? No — text is computed
    // lazily per call, but lastText caches. Reset by using a fresh host.
    const host2 = mockHost()
    apply(host2.ctx, { root })
    const snapshot = host2.renderSnapshot()
    expect(snapshot).toContain('待审批 1 条提案')
  })

  it('search shell finds committed entries and preflight records the event', async () => {
    const root = seededRoot()
    process.chdir(root)
    const hubCtx = createHubContext({ root })
    const tools = createTools(hubCtx)
    const propose = tools.find((tool) => tool.name === 'memory_propose')!
    await propose.run({ type: 'decision', title: '已批准条目', summary: '摘要在这里', body: '正文' })
    // Commit through the human channel (core-level, as the panel would).
    const hubCore = await import('agent-memory-hub')
    const { commitKnowledge, appendLedger, ledgerPath, readSequences, writeSequences } = hubCore
    const proposals = hubCore.listProposals(root)
    commitKnowledge(
      root,
      {
        type: proposals[0]!.frontmatter.type,
        title: proposals[0]!.frontmatter.title,
        summary: proposals[0]!.frontmatter.summary,
        scope: proposals[0]!.frontmatter.scope,
        tags: proposals[0]!.frontmatter.tags,
        body: '正文',
        actor: 'panel',
      },
      {
        readSequences,
        writeSequences,
        appendLedger: (r, record) => appendLedger(ledgerPath(r), record),
      },
    )
    // Refresh the index the way a new turn would.
    const refreshed = createHubContext({ root })
    const tools2 = createTools(refreshed)
    const search = tools2.find((tool) => tool.name === 'memory_search')!
    const hits = (await search.run({ query: '已批准' })) as { hits: Array<{ id: string; title: string }> }
    expect(hits.hits).toHaveLength(1)
    expect(hits.hits[0]?.id).toMatch(/^DEC-\d{6}$/)
    const preflight = tools2.find((tool) => tool.name === 'memory_preflight')!
    const pack = (await preflight.run({ intent: '已批准条目' })) as { status: string; pack: string }
    expect(pack.status).toBe('ready')
    expect(pack.pack).toContain('DEC-')
  })

  it('every tool output survives the lossless-JSON contract (no undefined values)', async () => {
    const root = seededRoot()
    process.chdir(root)
    // Seed one entry, including a proposal, so get/status/preflight all have
    // realistic payloads; dejavu gets an indexed transcript.
    const hubCtx = createHubContext({ root })
    const tools = createTools(hubCtx)
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find((candidate) => candidate.name === name)!
      const value = await tool.run(args)
      assertLossless(value, name)
      return value
    }
    await run('memory_propose', {
      type: 'decision',
      title: '无损校验条目',
      summary: '用于 lossless 合同验证',
      body: '正文',
    })
    await run('memory_dejavu', {
      action: 'index',
      sessionId: 's-lossless',
      text: '测试转录文本，覆盖 preview 与 token 索引路径，长度超过一百六十字符以满足截断逻辑的分支条件……'.padEnd(180, 'x'),
      location: 'test://lossless',
    })
    await run('memory_dejavu', { action: 'check', query: '无损校验' })
    // status exercises lockInfo (no lock held); get exercises frontmatter passthrough.
    const status = (await run('memory_status')) as { acceptedCount: number; pendingCount: number }
    expect(status.pendingCount).toBe(1)
    await run('memory_search', { query: '无损校验' })
    await run('memory_preflight', { intent: '无损校验条目' })
    // get before and after commit-style usage; full=true and default both.
    await run('memory_get', { id: 'PRO-000001' })
    await run('memory_close_task', { assessment: 'deferred' })
    await run('memory_cite', { id: 'PRO-000001', purpose: 'lossless contract test' })

    // Legacy entry shape (predecessor-era frontmatter: no created/updated keys,
    // timestamps in extra.*_at) must not leak undefined into tool output.
    const legacyDir = join(root, 'knowledge', 'decision')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      join(legacyDir, 'DEC-999999.md'),
      [
        '---',
        'id: DEC-999999',
        'version: 1',
        'type: decision',
        'status: accepted',
        'title: legacy entry without created/updated',
        'summary: predecessor-era frontmatter shape',
        'scope: {level: global}',
        'tags: []',
        '---',
        'legacy body',
      ].join('\n'),
    )
    const legacy = (await run('memory_get', { id: 'DEC-999999' })) as { frontmatter: Record<string, unknown> }
    expect(legacy.frontmatter).not.toHaveProperty('created')
    expect(legacy.frontmatter).not.toHaveProperty('updated')
  })
})
