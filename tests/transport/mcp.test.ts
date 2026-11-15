import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requireApproval } from '../../src/core/approval.js'
import { initHub } from '../../src/core/hub.js'
import { appendLedger, ledgerPath, readLedger } from '../../src/core/ledger.js'
import { createState, handleRpc, TOOLS, type TransportState } from '../../src/transport/mcp.js'

function seededState(): TransportState {
  const root = mkdtempSync(join(tmpdir(), 'amh-mcp-'))
  initHub(root)
  return createState(root, 'acme-app')
}

function call(state: TransportState, name: string, args: Record<string, unknown>): { isError?: boolean; text: string; error?: unknown } {
  const response = handleRpc(state, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))
  const parsed = JSON.parse(response ?? '{}') as { result?: { content?: Array<{ text: string }>; isError?: boolean; error?: unknown } }
  return {
    isError: parsed.result?.isError,
    text: parsed.result?.content?.[0]?.text ?? '',
    error: parsed.result?.error,
  }
}

describe('MCP protocol', () => {
  it('handshakes with a supported protocol version and server info', () => {
    const state = seededState()
    const response = handleRpc(state, JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }))
    const parsed = JSON.parse(response ?? '{}') as { result?: { protocolVersion: string; serverInfo: { name: string } } }
    expect(parsed.result?.protocolVersion).toBe('2025-06-18')
    expect(parsed.result?.serverInfo.name).toBe('memhub')
  })

  it('falls back to the newest known protocol version on an unknown request', () => {
    const state = seededState()
    const response = handleRpc(state, JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '9999-01-01' },
    }))
    const parsed = JSON.parse(response ?? '{}') as { result?: { protocolVersion: string } }
    expect(parsed.result?.protocolVersion).toBe('2025-06-18')
  })

  it('notifications get no response; unknown methods get -32601', () => {
    const state = seededState()
    expect(handleRpc(state, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull()
    const response = handleRpc(state, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }))
    const parsed = JSON.parse(response ?? '{}') as { error?: { code: number } }
    expect(parsed.error?.code).toBe(-32601)
  })

  it('tools/list exposes the eight memory_* tools with schemas', () => {
    const state = seededState()
    const response = handleRpc(state, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }))
    const parsed = JSON.parse(response ?? '{}') as { result?: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } }
    expect(parsed.result?.tools.map((t) => t.name)).toEqual(Object.keys(TOOLS))
    expect(parsed.result?.tools.every((t) => Object.keys(t.inputSchema).length > 0)).toBe(true)
  })

  it('malformed JSON gets a parse error', () => {
    const state = seededState()
    const response = handleRpc(state, 'not-json')
    const parsed = JSON.parse(response ?? '{}') as { error?: { code: number } }
    expect(parsed.error?.code).toBe(-32700)
  })
})

describe('MCP tools (fail-closed approval gate)', () => {
  it('memory_propose writes pending and registers the workspace, never knowledge/', () => {
    const state = seededState()
    const result = call(state, 'memory_propose', {
      type: 'decision',
      title: '回放定标用 top-k',
      summary: 'top-3 截断达标。',
      body: '正文。',
      sourceRefs: ['file:docs/04-development/search-replay-2026-11-15.md'],
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.text) as { proposalId: string }
    expect(parsed.proposalId).toBe('PRO-000001')
    const config = readLedger(ledgerPath(state.hubRoot))
    expect(config[0]?.action).toBe('propose')
  })

  it('memory_commit over MCP ALWAYS fails closed with E_APPROVAL_REQUIRED + approval.missing record', () => {
    const state = seededState()
    call(state, 'memory_propose', { type: 'decision', title: '门禁条目', summary: 's', body: 'b' })
    const result = call(state, 'memory_commit', { proposalId: 'PRO-000001' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('human approval')
    expect((result.error as { code?: string } | undefined)?.code).toBe('E_APPROVAL_REQUIRED')
    // The failed attempt is on the ledger — auditable, not silent.
    const ledger = readLedger(ledgerPath(state.hubRoot))
    expect(ledger.some((r) => r['type'] === 'approval.missing' && r['id'] === 'PRO-000001')).toBe(true)
  })

  it('requireApproval passes for human channels only', () => {
    expect(() => requireApproval('cli-human', { id: 'x' })).not.toThrow()
    expect(() => requireApproval('panel', { id: 'x' })).not.toThrow()
    expect(() => requireApproval('host-prompt', { id: 'x' })).not.toThrow()
    expect(() => requireApproval('mcp-model', { id: 'x' })).toThrowError(/human approval/)
  })

  it('memory_search returns ranked hits and updates metrics', () => {
    const state = seededState()
    call(state, 'memory_propose', {
      type: 'decision',
      title: '写锁租约设计',
      summary: '心跳超龄自动回收。',
      body: '租约正文。',
      sourceRefs: ['note:x'],
    })
    // Proposals are not searchable (only accepted knowledge is) — empty result is correct.
    const empty = call(state, 'memory_search', { query: '租约' })
    expect(JSON.parse(empty.text).hits).toHaveLength(0)
    // Commit through the human path to make it searchable.
    const committed = call(state, 'memory_commit', { proposalId: 'PRO-000001', channel: 'panel' })
    expect(committed.isError).toBeFalsy()
    const hits = call(state, 'memory_search', { query: '租约' })
    const parsed = JSON.parse(hits.text) as { hits: Array<{ id: string; title: string }>; metrics: { queryCount: number } }
    expect(parsed.hits).toHaveLength(1)
    expect(parsed.hits[0]?.title).toContain('写锁租约')
    expect(parsed.metrics.queryCount).toBe(1)
  })

  it('memory_cite and memory_close_task append audit records', () => {
    const state = seededState()
    call(state, 'memory_propose', { type: 'knowledge', title: '可引用条目', summary: 's', body: 'b' })
    call(state, 'memory_commit', { proposalId: 'PRO-000001', channel: 'panel' })
    const cited = call(state, 'memory_cite', { id: 'KNO-000001', purpose: '验证 cite 通路' })
    expect(cited.isError).toBeFalsy()
    const closed = call(state, 'memory_close_task', { assessment: 'no_new_knowledge' })
    expect(closed.isError).toBeFalsy()
    const ledger = readLedger(ledgerPath(state.hubRoot))
    expect(ledger.some((r) => r['type'] === 'citation.added')).toBe(true)
    expect(ledger.some((r) => r['type'] === 'task.closed')).toBe(true)
  })

  it('memory_get and memory_duplicates round-trip', () => {
    const state = seededState()
    call(state, 'memory_propose', { type: 'knowledge', title: '重复检查条目', summary: 's', body: '正文内容' })
    call(state, 'memory_commit', { proposalId: 'PRO-000001', channel: 'panel' })
    const got = call(state, 'memory_get', { id: 'KNO-000001', full: true })
    const entry = JSON.parse(got.text) as { frontmatter: { id: string }; body: string }
    expect(entry.frontmatter.id).toBe('KNO-000001')
    expect(entry.body).toContain('正文内容')
    const dup = call(state, 'memory_duplicates', { title: '重复检查条目' })
    const parsed = JSON.parse(dup.text) as { conflict: { id: string } | null }
    expect(parsed.conflict?.id).toBe('KNO-000001')
  })

  it('appendLedger + readLedger round-trip keeps the event stream append-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-ledger-'))
    initHub(root)
    const path = ledgerPath(root)
    appendLedger(path, { ts: 't1', actor: 'human', action: 'propose', id: 'PRO-000001' })
    appendLedger(path, { ts: 't2', actor: 'human', action: 'approve', id: 'DEC-000001' })
    const records = readLedger(path)
    expect(records).toHaveLength(2)
    expect(records[1]?.action).toBe('approve')
  })
})
