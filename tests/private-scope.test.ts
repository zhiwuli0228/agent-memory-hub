import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitKnowledge, getEntry, listEntries } from '../src/core/store.js'
import { appendLedger, readSequences, writeSequences } from '../src/core/ledger.js'
import { initHub } from '../src/core/hub.js'
import { isVisibleIn } from '../src/core/search.js'
import { hubSync, type HubFetch } from '../src/cli.js'

function helpers(root: string) {
  return { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
}

describe('ADR-0020 private scope', () => {
  it('round-trips through frontmatter and stays locally visible', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-priv-'))
    initHub(root)
    const h = helpers(root)
    const r = commitKnowledge(root, { type: 'knowledge', title: '与客户谈判的底线备忘', summary: '仅本人可见的价格底线', scope: { level: 'private' }, tags: [], body: 'mine only', actor: 'me' }, h)
    const e = getEntry(root, r.id)
    expect(e.frontmatter.scope).toEqual({ level: 'private' })
    // locally visible to any local viewer (owner's index)
    expect(isVisibleIn(e.frontmatter.scope, { workspaceId: 'proj-x' })).toBe(true)
    // and it renders private into the file
    expect(readFileSync(r.path, 'utf8')).toContain('level: private')
  })

  it('hub push skips private entries and reports the count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-priv-push-'))
    initHub(root)
    const h = helpers(root)
    commitKnowledge(root, { type: 'decision', title: '共享的选型决策', summary: '团队可见的选型结论', scope: { level: 'global' }, tags: [], body: 'share', actor: 'me' }, h)
    commitKnowledge(root, { type: 'knowledge', title: '私有的薪资谈判记录', summary: '仅本人可见', scope: { level: 'private' }, tags: [], body: 'secret', actor: 'me' }, h)
    const received: Array<Record<string, unknown>> = []
    const fetchImpl: HubFetch = async (_url, init) => {
      received.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
      return { ok: true, status: 200, body: { proposalId: 'PRO-X' } }
    }
    const result = await hubSync(root, 'push', 'http://central.test', undefined, fetchImpl)
    expect(result.privateSkipped).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]?.['title']).toBe('共享的选型决策')
  })

  it('listEntries never leaks private into shareable listings semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'amh-priv-list-'))
    initHub(root)
    const h = helpers(root)
    commitKnowledge(root, { type: 'knowledge', title: '私有条目甲', summary: '私人笔记', scope: { level: 'private' }, tags: [], body: 'x', actor: 'me' }, h)
    const all = listEntries(root)
    expect(all).toHaveLength(1)
    expect(all[0]?.frontmatter.scope.level).toBe('private')
  })
})
