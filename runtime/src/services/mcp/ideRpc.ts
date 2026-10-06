import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ConnectedMCPServer } from './types.js'

/**
 * Call an IDE tool directly as an RPC
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool
 * @param client The IDE client to use for the RPC call
 * @returns The result of the tool call
 */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const { callIdeRpcWithLoadedClient } = await import('./client.js')
  return callIdeRpcWithLoadedClient(toolName, args, client)
}
