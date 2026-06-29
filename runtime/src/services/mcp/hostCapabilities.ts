import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ListRootsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { logMCPDebug } from '../../utils/log.js'

export type McpHostElicitationCapabilityMode = 'none' | 'empty' | 'form-url'

export interface McpSamplingHandlers {
  createMessage(params: {
    readonly serverName: string
    readonly requestId: string | number | undefined
    readonly request: CreateMessageRequest
    readonly contextMeta?: unknown
    readonly signal?: AbortSignal
  }): Promise<CreateMessageResult>
}

export interface McpHostRequestHandlerOptions {
  readonly rootPath?: string
  readonly samplingHandlers?: McpSamplingHandlers
}

interface McpRequestHandlerExtra {
  readonly signal?: AbortSignal
  readonly requestId?: unknown
  readonly _meta?: unknown
}

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

function requestIdFromMcpRequest(
  request: CreateMessageRequest,
): string | number | undefined {
  const id = (request as { readonly id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

function requestIdFromMcpExtra(
  extra: McpRequestHandlerExtra | undefined,
): string | number | undefined {
  const id = extra?.requestId
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

export function configureMcpHostRequestHandlers(
  client: Client,
  serverName: string,
  rootPathOrOptions: string | McpHostRequestHandlerOptions = getOriginalCwd(),
): void {
  const options =
    typeof rootPathOrOptions === 'string'
      ? { rootPath: rootPathOrOptions }
      : rootPathOrOptions
  const rootPath = options.rootPath ?? getOriginalCwd()
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
    async (
      request: CreateMessageRequest,
      extra?: McpRequestHandlerExtra,
    ): Promise<CreateMessageResult> => {
      logMCPDebug(serverName, `Received sampling/createMessage request from server`)
      if (options.samplingHandlers !== undefined) {
        const contextMeta = request.params?._meta ?? extra?._meta
        return options.samplingHandlers.createMessage({
          serverName,
          requestId:
            requestIdFromMcpExtra(extra) ?? requestIdFromMcpRequest(request),
          request,
          ...(contextMeta !== undefined ? { contextMeta } : {}),
          ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
        })
      }
      return createUnavailableSamplingResult()
    },
  )
}
