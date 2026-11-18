import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installHostCommand } from '../src/cli.js'
import { initHub } from '../src/core/hub.js'

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'amh-install-'))
}

const hubRoot = join(tmpdir(), 'amh-install-hub')

describe('memhub install <host>', () => {
  it('registers claude-code: merges mcpServers, backs up an existing config, auto-inits the hub', () => {
    const home = fakeHome()
    const cfgFile = join(home, '.claude.json')
    // An existing config with other content must survive the merge.
    require('node:fs').writeFileSync(cfgFile, JSON.stringify({ someOtherKey: 42 }))
    const r = installHostCommand('claude-code', hubRoot, { home, setEnv: false })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('updated')
    expect(existsSync(hubRoot)).toBe(true) // auto-init
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { someOtherKey: number; mcpServers: Record<string, { command: string; args: string[] }> }
    expect(cfg.someOtherKey).toBe(42) // untouched
    expect(cfg.mcpServers['memory-hub'].command).toBe('node')
    expect(cfg.mcpServers['memory-hub'].args).toHaveLength(4) // <cli.js> mcp --root <hub>
    expect(cfg.mcpServers['memory-hub'].args[1]).toBe('mcp')
    expect(cfg.mcpServers['memory-hub'].args[3]).toBe(hubRoot)
    expect(existsSync(`${cfgFile}.bak-memhub`)).toBe(true) // pre-write backup
  })

  it('registers opencode: mcp memory-hub local entry with node + cli + root args', () => {
    const home = fakeHome()
    const r = installHostCommand('opencode', hubRoot, { home, setEnv: false })
    expect(r.ok).toBe(true)
    const cfgFile = join(home, '.config', 'opencode', 'opencode.json')
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { mcp: Record<string, { type: string; enabled: boolean; command: string[] }> }
    expect(cfg.mcp['memory-hub'].type).toBe('local')
    expect(cfg.mcp['memory-hub'].enabled).toBe(true)
    expect(cfg.mcp['memory-hub'].command[0]).toBe('node')
    expect(cfg.mcp['memory-hub'].command[2]).toBe('mcp')
  })

  it('is idempotent: a second identical run reports unchanged (no churn)', () => {
    const home = fakeHome()
    installHostCommand('gemini', hubRoot, { home, setEnv: false })
    const cfgFile = join(home, '.gemini', 'settings.json')
    const before = readFileSync(cfgFile, 'utf8')
    const r2 = installHostCommand('gemini', hubRoot, { home, setEnv: false })
    expect(r2.action).toBe('unchanged')
    expect(readFileSync(cfgFile, 'utf8')).toBe(before)
  })

  it('codex: does not rewrite TOML, points the human at the exact block', () => {
    const home = fakeHome()
    const r = installHostCommand('codex', hubRoot, { home, setEnv: false })
    expect(r.ok).toBe(true)
    expect(r.configFile).toContain(join('.codex', 'config.toml'))
    expect(r.nextStep).toContain('[mcp_servers.memory-hub]')
    expect(r.nextStep).toContain('"mcp"')
  })

  it('initHub of the install target wrote a .gitignore (repo-ready from day one)', () => {
    expect(existsSync(join(hubRoot, '.gitignore'))).toBe(true)
  })
})
