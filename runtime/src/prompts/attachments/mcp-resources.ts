/**
 * MCP resource mention attachment producer.
 *
 * Restores the active per-turn pipeline for user-authored `@server:uri`
 * mentions. MCP resource bytes are remote server-controlled data, so the
 * renderer must frame them as untrusted content before they reach the model.
 *
 * @module
 */

import type { MCPResourceDescriptor } from "../../mcp-client/resources.js";
import type { McpManager } from "../../session/session.js";
import {
  extractMcpResourceMentions,
  parseMcpResourceMention,
} from "../../utils/mcpResourceMentions.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { McpResourceAttachment } from "./types.js";

interface SessionLikeForMcpResources {
  readonly services?: {
    readonly mcpManager?: Pick<
      McpManager,
      "getResourcesByServer" | "readResource"
    >;
  };
}

function resourceByUri(
  resources: readonly MCPResourceDescriptor[],
  uri: string,
): MCPResourceDescriptor | null {
  return resources.find((resource) => resource.uri === uri) ?? null;
}

export const mcpResourcesProducer: AttachmentProducer = async (opts) => {
  const mentions = extractMcpResourceMentions(opts.userInput);
  if (opts.signal.aborted || mentions.length === 0) return [];

  const session = opts.sessionKey as SessionLikeForMcpResources;
  const manager = session.services?.mcpManager;
  if (
    typeof manager?.getResourcesByServer !== "function" ||
    typeof manager.readResource !== "function"
  ) {
    return [];
  }

  const attachments: McpResourceAttachment[] = [];

  for (const mention of mentions) {
    if (opts.signal.aborted) break;
    const parsed = parseMcpResourceMention(mention);
    if (parsed === null) continue;

    try {
      const resources = await manager.getResourcesByServer(
        parsed.serverName,
        opts.signal,
      );
      const resource = resourceByUri(resources, parsed.uri);
      if (resource === null) continue;
      const content = await manager.readResource(
        resource.namespacedName,
        opts.signal,
      );
      if (content === null) continue;

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
    } catch (error) {
      if (opts.signal.aborted) throw opts.signal.reason ?? error;
      continue;
    }
  }

  return attachments;
};
