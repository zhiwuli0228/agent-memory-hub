import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initHub } from '../../src/core/hub.js'
import { appendLedger, ledgerPath, readLedger, readSequences, writeSequences } from '../../src/core/ledger.js'
import { createProposal } from '../../src/core/store.js'
import { createApiState, gradeFor, handleApi, type ApiState } from '../../src/transport/server.js'
import { PANEL_HTML } from '../../src/transport/panel.js'
import type { LedgerRecord } from '../../src/core/ledger.js'
import type { KnowledgeType } from '../../src/core/types.js'

function seededState(): { state: ApiState; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'amh-api-'))
  initHub(root)
  return { state: createApiState(root, 'acme-app'), root }
}

function ledgerHelpers(): {
  readSequences: (root: string) => Record<string, number>
  writeSequences: (root: string, seq: Record<string, number>) => void
  appendLedger: (root: string, record: LedgerRecord) => void
} {
  return {
    readSequences,
    writeSequences,
    appendLedger: (root, record) => appendLedger(ledgerPath(root), record),
  }
}

function propose(root: string, type: KnowledgeType, title: string, body = `body of ${title}`): string {
  return createProposal(
    root,
    {
      type,
      title,
      summary: `summary of ${title}`,
      scope: { level: 'project', workspaceId: 'acme-app' },
      tags: [],
      body,
      sourceRefs: ['note:test'],
      actor: 'model',
    },
    ledgerHelpers(),
  ).id
}

function listLedger(root: string): LedgerRecord[] {
  return readLedger(ledgerPath(root))
}

describe('graded approval', () => {
  it('behavior-shaping types require individual approval; the rest may batch', () => {
    expect(gradeFor('decision')).toBe('individual')
    expect(gradeFor('constraint')).toBe('individual')
    expect(gradeFor('api-catalog')).toBe('individual')
    expect(gradeFor('knowledge')).toBe('batch')
    expect(gradeFor('playbooks')).toBe('batch')
    expect(gradeFor('process')).toBe('batch')
    expect(gradeFor('open-questions')).toBe('batch')
    expect(gradeFor('runtime-base')).toBe('batch')
    expect(gradeFor('assets')).toBe('batch')
  })
})

describe('panel API', () => {
  it('status reports hub + workspace + counts', () => {
    const { state } = seededState()
    const response = handleApi(state, 'GET', '/api/status')
    expect(response.status).toBe(200)
    const body = response.body as { workspace: { workspaceId: string }; acceptedCount: number }
    expect(body.workspace.workspaceId).toBe('acme-app')
    expect(body.acceptedCount).toBe(0)
  })

  it('inbox lists pending proposals with their grade', () => {
    const { state, root } = seededState()
    propose(root, 'decision', '逐条审批的决策')
    const response = handleApi(state, 'GET', '/api/inbox')
    const proposals = (response.body as { proposals: Array<{ grade: string }> }).proposals
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.grade).toBe('individual')
  })

  it('approving a decision individually commits it (panel is a human channel)', () => {
    const { state, root } = seededState()
    const id = propose(root, 'decision', '面板批准的决策', '面板正文')
    const response = handleApi(state, 'POST', `/api/inbox/${id}/approve`)
    expect(response.status).toBe(200)
    const results = (response.body as { results: Array<{ knowledgeId?: string }> }).results
    expect(results[0]?.knowledgeId).toMatch(/^DEC-\d{6}$/)
    expect(listLedger(root).some((r) => r['type'] === 'proposal.committed' && r['channel'] === 'panel')).toBe(true)
    expect(existsSync(join(root, 'pending', `${id}.md`))).toBe(false)
  })

  it('batch approval of decision/constraint is refused (graded enforcement)', () => {
    const { state, root } = seededState()
    const idA = propose(root, 'decision', '批A')
    const idB = propose(root, 'constraint', '批B')
    const response = handleApi(state, 'POST', '/api/inbox/approve', { ids: [idA, idB] })
    expect(response.status).toBe(403)
    expect((response.body as { error: string }).error).toContain('individually')
  })

  it('batch approval works for batch-grade types', () => {
    const { state, root } = seededState()
    const idA = propose(root, 'knowledge', '知识A')
    const idB = propose(root, 'playbooks', '手册B')
    const response = handleApi(state, 'POST', '/api/inbox/approve', { ids: [idA, idB] })
    expect(response.status).toBe(200)
    const results = (response.body as { results: Array<{ knowledgeId?: string }> }).results
    expect(results.every((r) => r.knowledgeId !== undefined)).toBe(true)
    expect(listLedger(root).filter((r) => r['type'] === 'proposal.committed')).toHaveLength(2)
  })

  it('reject removes the pending file and ledgers the rejection with a note', () => {
    const { state, root } = seededState()
    const id = propose(root, 'knowledge', '被拒条目')
    const response = handleApi(state, 'POST', `/api/inbox/${id}/reject`, { note: '写错了' })
    expect(response.status).toBe(200)
    expect(existsSync(join(root, 'pending', `${id}.md`))).toBe(false)
    expect(listLedger(root).some((r) => r['type'] === 'proposal.rejected' && r['note'] === '写错了')).toBe(true)
  })

  it('panel search uses the refreshed index (new commit is findable)', () => {
    const { state, root } = seededState()
    const id = propose(root, 'knowledge', '回放定标结论', 'top-3 截断达标')
    handleApi(state, 'POST', `/api/inbox/${id}/approve`)
    const response = handleApi(state, 'POST', '/api/search', { query: '回放定标' })
    const hits = (response.body as { hits: Array<{ title: string }> }).hits
    expect(hits.some((hit) => hit.title === '回放定标结论')).toBe(true)
  })

  it('unknown routes 404; unknown proposals 404 with a clean error body', () => {
    const { state } = seededState()
    expect(handleApi(state, 'GET', '/api/nothing').status).toBe(404)
    expect(handleApi(state, 'POST', '/api/inbox/PRO-999999/approve').status).toBe(404)
  })

  it('panel HTML is a single self-contained file with graded badges', () => {
    expect(PANEL_HTML).toContain('逐条审批')
    expect(PANEL_HTML).toContain('可批量')
    expect(PANEL_HTML).toContain('/api/inbox')
    expect(PANEL_HTML).not.toMatch(/\ssrc=/i) // no external scripts
    expect(PANEL_HTML).not.toMatch(/\shref=/i) // no external stylesheets
    expect(PANEL_HTML).toContain('/api/entries')
    expect(PANEL_HTML).toContain('/api/ledger')
    expect(PANEL_HTML).toContain('/api/journal')
  })

  describe('console management routes (ADR-0010)', () => {
    it('entries lists accepted entries with metadata; detail returns frontmatter + body', () => {
      const { state, root } = seededState()
      const id = propose(root, 'knowledge', '浏览条目', '正文内容在此')
      handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      const list = handleApi(state, 'GET', '/api/entries')
      expect(list.status).toBe(200)
      const entries = (list.body as { entries: Array<{ id: string; status: string }> }).entries
      expect(entries).toHaveLength(1)
      expect(entries[0]?.status).toBe('accepted')
      const detail = handleApi(state, 'GET', `/api/entries/${entries[0]?.id}`)
      expect(detail.status).toBe(200)
      const body = detail.body as { frontmatter: { title: string }; body: string; path: string }
      expect(body.frontmatter.title).toBe('浏览条目')
      expect(body.body).toContain('正文内容在此')
      expect(body.path).toContain('knowledge')
    })

    it('deprecate soft-removes an entry (status flips, ledger records the action)', () => {
      const { state, root } = seededState()
      const id = propose(root, 'knowledge', '将被废弃')
      handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      const committed = (handleApi(state, 'GET', '/api/entries').body as { entries: Array<{ id: string }> }).entries[0]?.id
      const response = handleApi(state, 'POST', `/api/entries/${committed}/deprecate`, { reason: '过期做法' })
      expect(response.status).toBe(200)
      const detail = handleApi(state, 'GET', `/api/entries/${committed}`)
      expect((detail.body as { frontmatter: { status: string } }).frontmatter.status).toBe('deprecated')
      expect(listLedger(root).some((r) => r['action'] === 'deprecate' && r['note'] === '过期做法')).toBe(true)
      // Deprecated entries stay visible with includeSoftRemoved in /api/entries.
      const list = handleApi(state, 'GET', '/api/entries')
      expect((list.body as { entries: Array<{ status: string }> }).entries[0]?.status).toBe('deprecated')
    })

    it('hard delete physically removes the file but leaves a ledger trace', () => {
      const { state, root } = seededState()
      const id = propose(root, 'knowledge', '将被删除')
      handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      const committed = (handleApi(state, 'GET', '/api/entries').body as { entries: Array<{ id: string; path: string }> }).entries[0]
      const response = handleApi(state, 'POST', `/api/entries/${committed?.id}/delete`, { reason: '隐私请求' })
      expect(response.status).toBe(200)
      expect(existsSync(committed?.path ?? '')).toBe(false)
      expect(listLedger(root).some((r) => r['action'] === 'delete' && r['note'] === '隐私请求')).toBe(true)
      expect(handleApi(state, 'GET', `/api/entries/${committed?.id}`).status).toBe(404)
    })

    it('ledger and journal endpoints return recent records', () => {
      const { state, root } = seededState()
      propose(root, 'knowledge', '账本验证')
      const ledger = handleApi(state, 'GET', '/api/ledger')
      expect(ledger.status).toBe(200)
      const records = (ledger.body as { records: Array<{ type?: string; action?: string }>; total: number }).records
      expect(records.length).toBeGreaterThan(0)
      // LedgerRecord is an event stream with two shapes: legacy `type` events
      // and the convenience `{ts, actor, action}` form — every record has one.
      expect(records[0]?.type ?? records[0]?.action).toBeDefined()
      const journal = handleApi(state, 'GET', '/api/journal')
      expect(journal.status).toBe(200)
      expect(Array.isArray((journal.body as { entries: unknown[] }).entries)).toBe(true)
      void root
    })
  })
})
