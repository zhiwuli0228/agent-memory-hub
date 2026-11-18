import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitKnowledge } from '../src/core/store.js'
import { appendLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import { initHub } from '../src/core/hub.js'
import { handleApi } from '../src/transport/server.js'
import { buildIndex, emptyMetrics } from '../src/core/search.js'
import { readHubConfig } from '../src/core/hub.js'

function helpers(root: string) {
  return { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
}

describe('ADR-0022 intake dedup', () => {
  it('a twin proposal is merged at intake, not queued twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-dedup-'))
    initHub(root)
    const state = {
      hubRoot: root,
      index: buildIndex(root, () => new Date().toISOString()),
      metrics: emptyMetrics(buildIndex(root, () => new Date().toISOString())),
      workspace: { workspaceId: 'sim', name: 'sim', path: root, exact: false },
    } as never
    const mk = (title: string, member: string) => ({ type: 'process', title, summary: `成员${member}记录的部署登录流程`, tags: [], body: 'same pitfall', sourceRefs: [member] })

    const first = handleApi(state, 'POST', '/api/propose', mk('部署环境登录流程', 'alice'))
    expect(first.status).toBe(200)
    const firstId = (first.body as { proposalId: string }).proposalId

    // member bob records the SAME pitfall next day — merged, no second queue entry
    const twin = handleApi(state, 'POST', '/api/propose', mk('部署环境登录流程', 'bob'))
    expect(twin.status).toBe(200)
    expect((twin.body as { duplicate: boolean }).duplicate).toBe(true)
    expect((twin.body as { proposalId: string }).proposalId).toBe(firstId)

    const inbox = handleApi(state, 'GET', '/api/inbox').body as { proposals: unknown[] }
    expect(inbox.proposals).toHaveLength(1)
  })

  it('an approved entry also absorbs later twins', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-dedup2-'))
    initHub(root)
    const h = helpers(root)
    commitKnowledge(root, { type: 'process', title: '发布回滚手册', summary: '发布失败时的回滚步骤', scope: { level: 'global' }, tags: [], body: 'rollback', actor: 'me' }, h)
    const state = {
      hubRoot: root,
      index: buildIndex(root, () => new Date().toISOString()),
      metrics: emptyMetrics(buildIndex(root, () => new Date().toISOString())),
      workspace: { workspaceId: 'sim', name: 'sim', path: root, exact: false },
    } as never
    const r = handleApi(state, 'POST', '/api/propose', { type: 'process', title: '发布回滚手册', summary: '发布失败回滚步骤', tags: [], body: 'x', sourceRefs: ['bob'] })
    expect((r.body as { duplicate: boolean }).duplicate).toBe(true)
    const id = (r.body as { proposalId: string }).proposalId
    expect(id).toMatch(/^(KNO|PRC|DEC|API|CON|OPE|PLA|RUN)-/)
  })
})
