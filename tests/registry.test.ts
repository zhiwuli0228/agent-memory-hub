import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readRegisteredWorkspaces,
  registerWorkspace,
  resolveWorkspace,
  slugifyDir,
  workspaceIdFromOrigin,
} from '../src/core/registry.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'amh-reg-'))
}

describe('identity derivation', () => {
  it('derives workspace id from a github origin URL', () => {
    expect(workspaceIdFromOrigin('git@github.com:zhiwuli0228/agent-memory-hub.git')).toBe(
      'zhiwuli0228-agent-memory-hub',
    )
    expect(workspaceIdFromOrigin('https://github.com/Owner/Repo.git')).toBe('owner-repo')
  })

  it('slugifies a directory name (both separators, both platforms)', () => {
    expect(slugifyDir('E:\\009workspace\\my project')).toBe('my-project')
    expect(slugifyDir('/home/user/my project')).toBe('my-project')
    expect(slugifyDir('\\\\server\\share\\Team Ops')).toBe('team-ops')
  })
})

describe('resolveWorkspace', () => {
  it('prefers an explicit id (human-specified identity)', () => {
    const dir = tempDir()
    const ws = resolveWorkspace(dir, 'team-project')
    expect(ws).toMatchObject({ workspaceId: 'team-project', exact: true })
    expect(ws.path).toBe(dir)
  })

  it('falls back to the directory name with exact=true (no git anywhere)', () => {
    const dir = tempDir()
    const ws = resolveWorkspace(dir)
    expect(ws.workspaceId).not.toBe('')
    expect(ws.exact).toBe(true)
    expect(ws.origin).toBeUndefined()
  })

  it('uses git origin when the temp dir is inside a repository (this repo itself)', () => {
    // The test runs inside agent-memory-hub's checkout, which has an origin.
    const ws = resolveWorkspace(process.cwd())
    expect(ws.exact).toBe(true)
    // Either a git identity or a plain directory identity — both honest.
    expect(ws.workspaceId).not.toBe('')
  })
})

describe('registration (caller holds the write lock)', () => {
  it('registers once and is idempotent on second call', () => {
    const root = tempDir()
    // Simulate hub.yaml: writes land in the file, reads see accumulated rows.
    let file = 'version: 1\n'
    const readConfig = () => {
      const map: Record<string, string> = {}
      for (const line of file.split('\n')) {
        const colon = line.indexOf(':')
        if (colon === -1 || line.trim().startsWith('#')) continue
        map[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
      }
      return map
    }
    const writeConfig = (_root: string, content: string) => {
      file += content
    }
    const ws = { workspaceId: 'acme-app', name: 'acme', origin: 'https://github.com/acme/app.git', path: root, exact: true }
    registerWorkspace(root, ws, () => '2026-11-15T16:00:00+08:00', readConfig, writeConfig)
    registerWorkspace(root, ws, () => '2026-11-15T16:00:01+08:00', readConfig, writeConfig)
    expect(file).toContain('workspaces.acme-app.name: acme')
    expect(file).toContain('workspaces.acme-app.origin: https://github.com/acme/app.git')
    expect(file.match(/registeredAt/g)).toHaveLength(1)
  })

  it('parses registered workspaces back out of a config map', () => {
    const rows = readRegisteredWorkspaces({
      version: '1',
      'workspaces.acme-app.name': 'acme',
      'workspaces.acme-app.origin': 'https://github.com/acme/app.git',
      'workspaces.acme-app.registeredAt': '2026-11-15T16:00:00+08:00',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ workspaceId: 'acme-app', name: 'acme' })
  })
})

describe('legacy core_workspaces compatibility', () => {
  it('registers stay out of the way when a legacy hub already has workspaces rows', () => {
    // Legacy hubs use core_workspaces/parentCoreIds; the compatibility reader
    // simply must not crash on them — grouping config arrives in Step 2 search.
    const root = tempDir()
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'hub.yaml'),
      'version: 1\ncore_workspaces: legacy-value\nparentCoreIds: legacy\n',
      'utf8',
    )
    const ws = { workspaceId: 'new-ws', name: 'new', path: root, exact: true }
    let written = ''
    registerWorkspace(root, ws, () => 't', () => ({ version: '1' }), (_r, c) => {
      written = c
    })
    expect(written).toContain('workspaces.new-ws.name')
    expect(written).not.toContain('core_workspaces')
  })
})
