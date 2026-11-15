import { mkdtempSync } from 'node:fs'
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
}

function mockHost(): RegisteredHost {
  const tools = new Map<string, ToolDefinition>()
  const logs: string[] = []
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
  }
  return { ctx, tools, logs }
}

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'amh-dsh-'))
  initHub(root)
  return root
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
    })) as { proposalId?: string; error?: string }
    expect(result.proposalId).toBe('PRO-000001')
    const search = tools.find((tool) => tool.name === 'memory_search')
    const hits = (await search!.run({ query: '适配器' })) as { hits: unknown[] }
    // Proposals are pending, not searchable — correct.
    expect(hits.hits).toHaveLength(0)
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
})
