/**
 * MCP resource mention attachment producer.
 *
 * Restores the active per-turn pipeline for user-authored `@server:uri`
 * mentions. MCP resource bytes are remote server-controlled data, so the
 * renderer must frame them as untrusted content before they reach the model.
 *
 * @module
 */

import {
  type ReadResourceResult,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from "../../services/mcp/client.js";
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ServerResource,
} from "../../services/mcp/types.js";
import {
  extractMcpResourceMentions,
  parseMcpResourceMention,
} from "../../utils/mcpResourceMentions.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { McpResourceAttachment } from "./types.js";

interface SessionLikeForMcpResources {
  listMcpClients?(): readonly MCPServerConnection[];
}

function connectedClientForServer(
  clients: readonly MCPServerConnection[],
  serverName: string,
): ConnectedMCPServer | null {
  const client = clients.find((candidate) => candidate.name === serverName);
  return client?.type === "connected" ? client : null;
}

function resourceByUri(
  resources: readonly ServerResource[],
  uri: string,
): ServerResource | null {
  return resources.find((resource) => resource.uri === uri) ?? null;
}

export const mcpResourcesProducer: AttachmentProducer = async (opts) => {
  const mentions = extractMcpResourceMentions(opts.userInput);
  if (opts.signal.aborted || mentions.length === 0) return [];

  const session = opts.sessionKey as SessionLikeForMcpResources;
  const clients = session.listMcpClients?.() ?? [];
  if (clients.length === 0) return [];

  const attachments: McpResourceAttachment[] = [];

  for (const mention of mentions) {
    if (opts.signal.aborted) break;
    const parsed = parseMcpResourceMention(mention);
    if (parsed === null) continue;
    const client = connectedClientForServer(clients, parsed.serverName);
    if (client === null || !client.capabilities?.resources) continue;

    try {
      const connected = await ensureConnectedClient(client);
      const resources = await fetchResourcesForClient(connected);
      const resource = resourceByUri(resources, parsed.uri);
      if (resource === null) continue;
      const content = (await connected.client.request(
        {
          method: "resources/read",
          params: { uri: parsed.uri },
        },
        ReadResourceResultSchema,
      )) as ReadResourceResult;

      attachments.push({
        kind: "mcp_resource",
        server: parsed.serverName,
        uri: parsed.uri,
        name: resource.name ?? parsed.uri,
        ...(resource.description !== undefined
          ? { description: resource.description }
          : {}),
        content,
      });
    } catch {
      continue;
    }
  }

  return attachments;
};
