import * as hub from 'agent-memory-hub'
import { resolveHubRoot, type AdapterConfig, type HostContext, type ToolDefinition } from './host-types.js'
import { createTools, createHubContext } from './tools.js'

/**
 * DSH thin adapter for agent-memory-hub (ADR-0001: no host glue in core —
 * the host side is this package). Registers memory_* tools on the cordis
 * tools service; initialization is async-safe: registration is synchronous,
 * tool bodies handle hub errors and return structured payloads, so a failed
 * mount never throws into the host loader.
 */

export const name = 'agent-memory-hub-dsh'
export const inject = ['tools']

export function apply(ctx: HostContext, config?: AdapterConfig): void {
  const root = resolveHubRoot(config)
  if (!hub.isHubInitialized(root)) {
    ctx.logger?.warn(
      `agent-memory-hub-dsh: hub not initialized at ${root} — memory tools disabled until \`memhub init --root ${root}\` runs`,
    )
    return
  }
  const hubCtx = createHubContext(config)
  const conflict = config?.toolConflict ?? 'skip'
  const disposers: Array<() => void> = []
  for (const definition of createTools(hubCtx)) {
    const { run, ...rest } = definition
    let toolName = rest.name
    const existing = ctx.tools.get(toolName)
    if (existing !== undefined) {
      if (conflict === 'skip') {
        ctx.logger?.warn(
          `agent-memory-hub-dsh: tool ${toolName} already registered by host or another plugin; skipping (toolConflict: skip)`,
        )
        continue
      }
      toolName = `${toolName}__amh`
      ctx.logger?.warn(`agent-memory-hub-dsh: tool name collision — registered as ${toolName} (toolConflict: suffix)`)
    }
    const tool: ToolDefinition = {
      ...rest,
      name: toolName,
      execute: (args) => run(args),
    }
    disposers.push(ctx.tools.register(tool))
  }
  ctx.logger?.info(`agent-memory-hub-dsh: ${disposers.length} memory tools registered (hub: ${root})`)
  ctx.effect?.(() => () => {
    for (const dispose of disposers) dispose()
  }, name)
}
