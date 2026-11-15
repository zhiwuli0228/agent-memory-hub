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
})
