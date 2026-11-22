import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli.js'
import { readLedger } from '../../src/core/ledger.js'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'amh-cli-'))
}

describe('memhub CLI', () => {
  it('init → inbox list shows the empty queue', () => {
    const root = tempRoot()
    expect(main(['init', '--root', root])).toBe(0)
    expect(main(['inbox', 'list', '--root', root])).toBe(0)
  })

  it('search before init fails with a descriptive error (exit 1)', () => {
    const root = tempRoot()
    const code = main(['search', 'x', '--root', root])
    expect(code).toBe(1)
    expect(existsSync(join(root, 'knowledge'))).toBe(false) // failed closed: no hub created
  })

  it('unknown command exits 1', () => {
    expect(main(['frobnicate'])).toBe(1)
  })

  it('ledger stays append-only across CLI operations', () => {
    const root = tempRoot()
    main(['init', '--root', root])
    const path = join(root, 'records', 'ledger.jsonl')
    const before = readFileSync(path, 'utf8')
    main(['status', '--root', root])
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readLedger(path)).toEqual([])
  })

  it('batch approve: several proposals land in one CLI call, bad id does not sink the rest', async () => {
    const { commitKnowledge, createProposal, listProposals } = await import('../../src/core/store.js')
    const { initHub } = await import('../../src/core/hub.js')
    const { appendLedger, ledgerPath, readSequences, writeSequences } = await import('../../src/core/ledger.js')
    const root = tempRoot()
    initHub(root)
    const helpers = { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
    const ids = ['A', 'B', 'C'].map(
      (n) =>
        createProposal(root, { type: 'process', title: `批量条目 ${n}`, summary: 's', scope: { level: 'global' }, tags: [], body: `body ${n}`, sourceRefs: ['n'] }, helpers).id,
    )
    const code = main(['inbox', 'approve', ids[0], ids[1], 'PRO-999999', '--root', root])
    expect(code).toBe(1) // one id was unknown → non-zero, but the good ones landed
    const remaining = listProposals(root).map((p) => p.id)
    expect(remaining).not.toContain(ids[0])
    expect(remaining).not.toContain(ids[1])
    expect(remaining).toContain(ids[2]) // untouched
    // Ledger carries both the commits and the not-found failure for audit.
    const ledger = readLedger(join(root, 'records', 'ledger.jsonl')).map((r) => r.type)
    expect(ledger.filter((t) => t === 'proposal.committed')).toHaveLength(2)
  })

  it('reject removes the proposal from the inbox (audit-only reject left the queue stuck)', async () => {
    const { createProposal, listProposals } = await import('../../src/core/store.js')
    const { initHub } = await import('../../src/core/hub.js')
    const { appendLedger, readSequences, writeSequences } = await import('../../src/core/ledger.js')
    const root = tempRoot()
    initHub(root)
    const helpers = { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
    const id = createProposal(root, { type: 'process', title: '待拒条目', summary: 's', scope: { level: 'global' }, tags: [], body: 'b', sourceRefs: ['n'] }, helpers).id
    expect(main(['inbox', 'reject', id, '--note', '测试拒绝', '--root', root])).toBe(0)
    expect(listProposals(root)).toHaveLength(0)
    expect(existsSync(join(root, 'pending', `${id}.md`))).toBe(false)
    expect(readLedger(join(root, 'records', 'ledger.jsonl')).some((r) => r.type === 'proposal.rejected')).toBe(true)
  })

  it('D06: CLI approve isolates a stale-base revision; --override forces it', async () => {
    const { commitKnowledge, createProposal, listProposals } = await import('../../src/core/store.js')
    const { initHub } = await import('../../src/core/hub.js')
    const { appendLedger, readSequences, writeSequences } = await import('../../src/core/ledger.js')
    const root = tempRoot()
    initHub(root)
    const helpers = { readSequences, writeSequences, appendLedger: (r: string, rec: Record<string, unknown>) => appendLedger(join(r, 'records', 'ledger.jsonl'), rec as never) }
    const target = commitKnowledge(root, { type: 'process', title: 'SOP', summary: 'v1', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v1', sourceRefs: ['n'] }, helpers)
    const id = createProposal(root, { type: 'process', title: 'SOP', summary: 'v2 修订', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2', sourceRefs: ['s1'], supersedes: [target.id] }, helpers).id
    // Concurrent advance: someone else lands v2 first.
    commitKnowledge(root, { id: target.id, type: 'process', title: 'SOP', summary: 'v2 别人', scope: { level: 'domain', domainId: 'team-ops' }, tags: [], body: 'v2 别人', sourceRefs: ['peer'] }, helpers)
    expect(main(['inbox', 'approve', id, '--root', root])).toBe(1)
    expect(listProposals(root)).toHaveLength(1) // kept, isolated
    expect(readFileSync(join(root, 'knowledge', 'groups', 'team-ops', 'process', `${target.id}.md`), 'utf8')).toContain('v2 别人')
    expect(main(['inbox', 'approve', id, '--override', '--root', root])).toBe(0)
    expect(listProposals(root)).toHaveLength(0)
    const ledger = readLedger(join(root, 'records', 'ledger.jsonl')).map((r) => r.type)
    expect(ledger).toContain('dispute.raised')
    expect(ledger).toContain('dispute.overridden')
  })
})
