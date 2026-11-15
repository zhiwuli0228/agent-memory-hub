/**
 * Minimal structural types for the DSH host surface the adapter touches.
 * Declared here (not imported from the host SDK) so the adapter has zero
 * host dependencies at build time — the host provides these capabilities.
 */

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  concurrencySafe?: boolean
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> | unknown
}

export interface HostContext {
  tools: {
    get(name: string): ToolDefinition | undefined
    register(tool: ToolDefinition): () => void
  }
  logger?: {
    info(message: string): void
    warn(message: string): void
  }
  effect?(dispose: () => () => void, name?: string): void
}

export interface AdapterConfig {
  /** Hub root directory. Empty/missing = $MEMHUB_ROOT or the process cwd. */
  root?: string
}

export function resolveHubRoot(config?: AdapterConfig): string {
  const explicit = config?.root
  if (explicit !== undefined && explicit !== '') return explicit
  return process.env['MEMHUB_ROOT'] ?? process.cwd()
}
