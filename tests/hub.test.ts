import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUB_README, initHub, readHubConfig } from '../src/core/hub.js'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'amh-hub-'))
}

describe('initHub', () => {
  it('creates the full directory layout + records + config + README', () => {
    const root = tempRoot()
    const result = initHub(root)
    expect(result.readme).toBe('written')
    for (const dir of ['knowledge', 'pending', 'history', 'records', 'journal']) {
      expect(existsSync(join(root, dir))).toBe(true)
    }
    expect(existsSync(join(root, 'knowledge', 'decision'))).toBe(true)
    expect(existsSync(join(root, 'knowledge', 'playbooks'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'records', 'sequences.json'), 'utf8'))).toEqual({})
    expect(readFileSync(join(root, 'records', 'ledger.jsonl'), 'utf8')).toBe('')
    expect(existsSync(join(root, 'hub.yaml'))).toBe(true)
    expect(readFileSync(join(root, HUB_README), 'utf8')).toContain('模型永远不能自批')
  })

  it('is idempotent and never overwrites an existing MEMORY-HUB.md', () => {
    const root = tempRoot()
    initHub(root)
    const readmePath = join(root, HUB_README)
    readFileSync(readmePath, 'utf8') // ensure readable
    const result = initHub(root)
    expect(result.readme).toBe('skipped-existing')
    expect(result.created).toEqual([])
  })

  it('reads flat hub.yaml config rows', () => {
    const root = tempRoot()
    initHub(root)
    const config = readHubConfig(root)
    expect(config['version']).toBe('1')
  })
})
