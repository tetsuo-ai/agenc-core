import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  type CreateMessageResult,
  type ListRootsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { logMCPDebug } from '../../utils/log.js'

export type McpHostElicitationCapabilityMode = 'none' | 'empty' | 'form-url'

export function getMcpRootUriForPath(path: string): string {
  return pathToFileURL(path).href
}

export function buildMcpHostClientCapabilities(
  elicitationMode: McpHostElicitationCapabilityMode = 'none',
): Record<string, unknown> {
  return {
    roots: {},
    sampling: {},
    ...(elicitationMode === 'empty'
      ? { elicitation: {} }
      : elicitationMode === 'form-url'
        ? { elicitation: { form: {}, url: {} } }
        : {}),
  }
}

export function createUnavailableSamplingResult(): CreateMessageResult {
  return {
    role: 'assistant',
    model: 'agenc-host',
    stopReason: 'endTurn',
    content: {
      type: 'text',
      text:
        'MCP sampling is not available for this AgenC connection. Ask the user to run the request directly in the main conversation.',
    },
  }
}

export function configureMcpHostRequestHandlers(
  client: Client,
  serverName: string,
  rootPath: string = getOriginalCwd(),
): void {
  client.setRequestHandler(ListRootsRequestSchema, async (): Promise<ListRootsResult> => {
    logMCPDebug(serverName, `Received ListRoots request from server`)
    return {
      roots: [
        {
          uri: getMcpRootUriForPath(rootPath),
        },
      ],
    }
  })

  client.setRequestHandler(
    CreateMessageRequestSchema,
    async (): Promise<CreateMessageResult> => {
      logMCPDebug(serverName, `Received sampling/createMessage request from server`)
      return createUnavailableSamplingResult()
    },
  )
}
