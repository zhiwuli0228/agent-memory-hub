import * as hub from 'agent-memory-hub'
import { resolveHubRoot, type AdapterConfig, type HostContext, type ToolDefinition } from './host-types.js'
import { createTools, createHubContext } from './tools.js'

/**
 * DSH thin adapter for agent-memory-hub (ADR-0001: no host glue in core —
 * the host side is this package). Registers memory_* tools on the cordis
 * tools service; initialization is async-safe: registration is synchronous,
 * tool bodies handle hub errors and return structured payloads, so a failed
 * mount never throws into the host loader.
 *
 * Also embeds the panel HTTP surface in-process (127.0.0.1:7777, ADR-0012)
 * so the DSH sidebar panel always has its audited data source — no manual
 * `memhub serve` step. Port conflicts (a user-started serve, another session)
 * are tolerated: we skip and the existing server keeps serving.
 */

export const name = 'agent-memory-hub-dsh'
export const inject = ['tools']

const PANEL_PORT = 7777

function startPanelServer(ctx: HostContext, root: string): void {
  try {
    const state = hub.createApiState(root)
    const server = hub.startServer(state, { port: PANEL_PORT, host: '127.0.0.1' })
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        ctx.logger?.info(`agent-memory-hub-dsh: panel port ${PANEL_PORT} already serving (manual serve or another session) — reusing it`)
        return
      }
      ctx.logger?.warn(`agent-memory-hub-dsh: panel server error: ${error.message}`)
    })
    ctx.logger?.info(`agent-memory-hub-dsh: panel console serving at http://127.0.0.1:${PANEL_PORT}/ (hub: ${root})`)
    ctx.effect?.(() => () => {
      try {
        server.close()
      } catch {
        // already closed
      }
    }, `${name}-panel`)
  } catch (error) {
    ctx.logger?.warn(`agent-memory-hub-dsh: panel server failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx: HostContext, config?: AdapterConfig): void {
  const root = resolveHubRoot(config)
  if (!hub.isHubInitialized(root)) {
    ctx.logger?.warn(
      `agent-memory-hub-dsh: hub not initialized at ${root} — memory tools disabled until \`memhub init --root ${root}\` runs`,
    )
    return
  }
  startPanelServer(ctx, root)
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
