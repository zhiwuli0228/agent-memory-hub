import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

describe('dsh client surface (client.js)', () => {
  it('registers a sidebar entry and its keyed central panel', () => {
    expect(src).toContain("inject('sidebar.panellist'")
    expect(src).toContain("inject('main'")
    expect(src).toContain("name: 'main'")
    expect(src).toContain("key: PANEL_ID")
  })

  it('embeds the serve console over loopback only and guides when it is down', () => {
    expect(src).toContain('http://127.0.0.1:7777')
    expect(src).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/) // zero non-loopback endpoints
    expect(src).toContain('memhub serve')
    expect(src).toContain('iframe')
    expect(src).toContain('setInterval') // auto-retry lights the panel up
  })

  it('is a module-loader factory with a slots-only injection and cleanup-safe polling', () => {
    expect(src).toContain('window.__ModuleLoader__.load')
    expect(src).toContain("id: 'dsh-agent-memory-hub'")
    expect(src).toContain("inject: ['slots']")
  })
})
