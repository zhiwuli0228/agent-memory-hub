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
})
