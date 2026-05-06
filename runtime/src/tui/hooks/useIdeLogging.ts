import { useEffect } from 'react'
import { logEvent } from '../../agenc/upstream/services/analytics/index.js' // upstream-import: keep target is owned by another Z-PURGE item
import { z } from 'zod/v4'
import type { MCPServerConnection } from '../../agenc/upstream/services/mcp/types' // upstream-import: keep target is owned by another Z-PURGE item
import { getConnectedIdeClient } from '../../utils/ide.js' // upstream-import: keep target is owned by another Z-PURGE item
import { lazySchema } from '../../utils/lazySchema.js' // upstream-import: keep target is owned by another Z-PURGE item

const LogEventSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      eventData: z.object({}).passthrough(),
    }),
  }),
)

export function useIdeLogging(mcpClients: MCPServerConnection[]): void {
  useEffect(() => {
    // Skip if there are no clients
    if (!mcpClients.length) {
      return
    }

    // Find the IDE client from the MCP clients list
    const ideClient = getConnectedIdeClient(mcpClients)
    if (ideClient) {
      // Register the log event handler
      ideClient.client.setNotificationHandler(
        LogEventSchema(),
        notification => {
          const { eventName, eventData } = notification.params
          logEvent(
            `tengu_ide_${eventName}`,
            eventData as { [key: string]: boolean | number | undefined },
          )
        },
      )
    }
  }, [mcpClients])
}
