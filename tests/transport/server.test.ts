import { existsSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

  it('panel exposes the two-level menu — 待审核/记忆库 as level 1, type categories as level 2', () => {
    // Level 1: the label the user asked for, plus the other two panes.
    expect(PANEL_HTML).toContain('待审核')
    expect(PANEL_HTML).toContain('记忆库')
    expect(PANEL_HTML).toContain('审计')
    // Level 2: a dedicated nav (不是把分类堆在一页的分区标题) with an 全部 entry.
    expect(PANEL_HTML).toContain('className="subnav"')
    expect(PANEL_HTML).toContain("'subitem '")
    expect(PANEL_HTML).toContain('navlbl')
    expect(PANEL_HTML).toContain('全部类型')
    // Type labels stay Chinese so the second level is readable.
    for (const label of ['决策', '约束', '知识', '流程', 'API 目录', '运行时基线', '操作手册']) {
      expect(PANEL_HTML).toContain(label)
    }
    // The 0.1.48 stacked-section layout must be gone: no per-type section heads.
    expect(PANEL_HTML).not.toContain('className="section-head"')
    expect(PANEL_HTML).not.toContain('function SectionHead')
  })

  it('panel <script> is valid JavaScript — a stray real newline inside a string literal breaks the whole console', () => {
    // Regression: the approveOne alert used '\n' INSIDE the PANEL_HTML template
    // literal; the compiler turned it into a real newline, producing a
    // SyntaxError in the browser and a completely unrendered console.
    // The panel now inlines several scripts (React UMD, react-dom, htm, app) —
    // validate them together the way the browser would.
    const scripts = [...PANEL_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '')
    expect(scripts.length).toBeGreaterThanOrEqual(4)
    const script = scripts.join('\n')
    // The compiled string must carry the ESCAPE SEQUENCE, not a raw line break.
    expect(script).toContain("'\\n'")
    // Hard proof: the whole inline script parses as JavaScript.
    expect(() => {
      // eslint-disable-next-line no-new-func
      new Function(script)
    }).not.toThrow()
    // The approve alert must carry the escape sequence, not a raw line break.
    const alertLine = script.split('\n').find((l) => l.includes('批准失败'))
    expect(alertLine).not.toBeUndefined()
    expect(alertLine).toContain("'\\n'")
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

    it('update route saves a new version (old snapshot goes to history/)', () => {
      const { state, root } = seededState()
      const id = propose(root, 'knowledge', '将通用化', '流程绑定 oracle1 环境')
      handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      const committed = (handleApi(state, 'GET', '/api/entries').body as { entries: Array<{ id: string }> }).entries[0]?.id
      const response = handleApi(state, 'POST', `/api/entries/${committed}/update`, {
        summary: '通用环境登录部署流程',
        body: '适用于任意目标环境的登录与部署流程，环境差异通过变量注入。',
      })
      expect(response.status).toBe(200)
      const body = response.body as { updated: string; version: number }
      expect(body.updated).toBe(committed)
      expect(body.version).toBe(2)
      const detail = handleApi(state, 'GET', `/api/entries/${committed}`)
      expect((detail.body as { frontmatter: { summary: string }; body: string }).frontmatter.summary).toContain('通用')
      expect(existsSync(join(root, 'history', 'knowledge', `${committed}@v1.md`))).toBe(true)
    })

    it('approving a proposal with supersedes upgrades the target version (re-extraction loop)', () => {
      const { state, root } = seededState()
      const id = propose(root, 'knowledge', '原始条目', '绑定具体环境的流程 v1')
      handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      const targetId = (handleApi(state, 'GET', '/api/entries').body as { entries: Array<{ id: string }> }).entries[0]?.id
      // Model proposes a generalized re-extraction bound to the original entry.
      createProposal(
        root,
        {
          type: 'knowledge',
          title: '通用环境登录部署流程',
          summary: '任意环境的登录与部署通用流程',
          scope: { level: 'project', workspaceId: 'acme-app' },
          tags: [],
          body: '通用流程正文',
          sourceRefs: ['note:re-extract'],
          actor: 'model',
          supersedes: [targetId ?? ''],
        },
        ledgerHelpers(),
      )
      const pending = (handleApi(state, 'GET', '/api/inbox').body as { proposals: Array<{ id: string }> }).proposals[0]?.id
      const response = handleApi(state, 'POST', `/api/inbox/${pending}/approve`)
      expect(response.status).toBe(200)
      const results = (response.body as { results: Array<{ knowledgeId?: string; version?: number }> }).results
      // Same id, bumped version — no duplicate entry created.
      expect(results[0]?.knowledgeId).toBe(targetId)
      expect(results[0]?.version).toBe(2)
      expect((handleApi(state, 'GET', '/api/entries').body as { entries: unknown[] }).entries).toHaveLength(1)
    })

    it('approval auto-commits locally when the hub root is a git repo (push stays explicit)', () => {
      const { state, root } = seededState()
      // Turn the temp hub into a repo with an identity so commits can run.
      spawnSync('git', ['init'], { cwd: root })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      const id = propose(root, 'knowledge', '自动提交验证', '批准即进本地 git 历史')
      const response = handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      expect(response.status).toBe(200)
      const results = (response.body as { results: Array<{ git?: { committed?: boolean } }> }).results
      expect(results[0]?.git?.committed).toBe(true)
      const log = spawnSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' })
      expect(log.stdout).toContain('approve:')
      // Nothing is pushed: local history only.
      const remote = spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8' })
      expect(remote.stdout.trim()).toBe('')
    })

    it('approval without a git repo degrades gracefully (no commit, approval still succeeds)', () => {
      const { state } = seededState()
      const id = propose(state.hubRoot, 'knowledge', '无仓批准', '非 git hub 不应阻塞审批')
      const response = handleApi(state, 'POST', `/api/inbox/${id}/approve`)
      expect(response.status).toBe(200)
      const results = (response.body as { results: Array<{ knowledgeId?: string; git?: { committed?: boolean; detail?: string } }> }).results
      expect(results[0]?.knowledgeId).toBeDefined()
      expect(results[0]?.git?.committed).toBe(false)
      expect(results[0]?.git?.detail).toContain('not a git repository')
    })
  })
})
