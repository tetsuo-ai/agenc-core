declare module '@ant/agenc-for-chrome-mcp' {
  import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

  export type PermissionMode =
    | 'ask'
    | 'skip_all_permission_checks'
    | 'follow_a_plan'

  export interface Logger {
    silly(message: string, ...args: unknown[]): void
    debug(message: string, ...args: unknown[]): void
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  }

  export interface AgenCForChromeContext {
    [key: string]: unknown
  }

  export function createAgenCForChromeMcpServer(
    context: AgenCForChromeContext,
  ): {
    connect(transport: Transport): Promise<void>
    close(): Promise<void>
  }

  export const BROWSER_TOOLS: readonly string[]
}
