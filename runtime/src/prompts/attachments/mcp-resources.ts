/**
 * MCP resource mention attachment producer.
 *
 * Canonical per-turn producer for user-authored `@server:uri` mentions.
 * MCP resource bytes are remote server-controlled data, so the renderer must
 * frame them as untrusted content before they reach the model.
 *
 * @module
 */

import { runAdmittedSessionBoundToolCall } from "../../budget/admitted-legacy-tool-call.js";
import {
  MAX_RESOURCE_BYTES,
  type MCPResourceContent,
  type MCPResourceContentBlock,
  type MCPResourceDescriptor,
} from "../../mcp-client/resources.js";
import { peekAmbientRuntimeSession } from "../../session/current-session.js";
import type { Tool } from "../../tools/types.js";
import { createCombinedAbortSignal } from "../../utils/combinedAbortSignal.js";
import {
  extractMcpResourceMentions,
  parseMcpResourceMention,
} from "../../utils/mcpResourceMentions.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { McpResourceAttachment } from "./types.js";

const MCP_RESOURCE_ATTACHMENT_TIMEOUT_MS = 1_000;
const MCP_RESOURCE_MENTION_MAX_COUNT = 10;
const MCP_RESOURCE_ATTACHMENT_MAX_RETAINED_BYTES = MAX_RESOURCE_BYTES;
const MCP_RESOURCE_ATTACHMENT_ADMISSION_TOOL: Tool = {
  name: "mcp.preflight.resource_attachment",
  description: "Read an MCP resource referenced by a user attachment.",
  inputSchema: {
    type: "object",
    properties: {
      server: { type: "string" },
      uri: { type: "string" },
    },
    required: ["server", "uri"],
    additionalProperties: false,
  },
  metadata: {
    family: "mcp",
    source: "mcp",
    mutating: false,
    hiddenByDefault: true,
  },
  isReadOnly: true,
  recoveryCategory: "idempotent",
  admissionEstimate: () => ({
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxCostUsd: 0,
  }),
  async execute() {
    throw new Error(
      "MCP resource attachment admission descriptor is not executable",
    );
  },
};

interface ResolvedMcpResource {
  readonly resource: MCPResourceDescriptor;
  readonly content: MCPResourceContent;
}

function contentBlockRetainedBytes(block: MCPResourceContentBlock): number {
  return (
    Buffer.byteLength(block.uri, "utf8") +
    (block.mimeType === undefined
      ? 0
      : Buffer.byteLength(block.mimeType, "utf8")) +
    (block.text === undefined
      ? Buffer.byteLength(block.blob, "utf8")
      : Buffer.byteLength(block.text, "utf8"))
  );
}

function resourceRetainedBytes(resolved: ResolvedMcpResource): number {
  const descriptor = resolved.resource;
  let total =
    Buffer.byteLength(descriptor.serverName, "utf8") +
    Buffer.byteLength(descriptor.uri, "utf8") +
    Buffer.byteLength(descriptor.namespacedName, "utf8") +
    (descriptor.name === undefined
      ? 0
      : Buffer.byteLength(descriptor.name, "utf8")) +
    (descriptor.description === undefined
      ? 0
      : Buffer.byteLength(descriptor.description, "utf8")) +
    (descriptor.mimeType === undefined
      ? 0
      : Buffer.byteLength(descriptor.mimeType, "utf8"));
  for (const block of resolved.content.contents) {
    total += contentBlockRetainedBytes(block);
    if (total > MCP_RESOURCE_ATTACHMENT_MAX_RETAINED_BYTES) break;
  }
  return total;
}

function resourceByUri(
  resources: readonly MCPResourceDescriptor[],
  uri: string,
): MCPResourceDescriptor | null {
  return resources.find((resource) => resource.uri === uri) ?? null;
}

export const mcpResourcesProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  const provenance = opts.turnProvenance;
  const rootHumanTurn = provenance?.rootHumanTurn;
  if (
    provenance === undefined ||
    provenance.turnId.length === 0 ||
    rootHumanTurn === undefined ||
    rootHumanTurn === null ||
    rootHumanTurn.turnId !== provenance.turnId ||
    trackingState.lastMcpResourceMentionTurnId === provenance.turnId
  ) {
    return [];
  }

  const mentions = extractMcpResourceMentions(rootHumanTurn.text);
  if (opts.signal.aborted || mentions.length === 0) return [];
  // Claim synchronously before resolving ambient authority or awaiting admission
  // so concurrent/retry sampling for one turn cannot issue duplicate reads.
  trackingState.lastMcpResourceMentionTurnId = provenance.turnId;

  const session = peekAmbientRuntimeSession();
  if (session === null || opts.sessionKey !== session) return [];

  const manager = session.services.mcpManager;
  if (
    typeof manager?.getResourcesByServer !== "function" ||
    typeof manager.readResource !== "function" ||
    typeof manager.getConnectedServers !== "function"
  ) {
    return [];
  }
  const getResourcesByServer = manager.getResourcesByServer.bind(manager);
  const readResource = manager.readResource.bind(manager);
  const connectedServers = manager.getConnectedServers();

  const attachments: McpResourceAttachment[] = [];
  let retainedBytes = 0;
  const deadline = createCombinedAbortSignal(opts.signal, {
    timeoutMs: MCP_RESOURCE_ATTACHMENT_TIMEOUT_MS,
  });

  try {
    for (const mention of mentions.slice(0, MCP_RESOURCE_MENTION_MAX_COUNT)) {
      if (
        deadline.signal.aborted ||
        retainedBytes >= MCP_RESOURCE_ATTACHMENT_MAX_RETAINED_BYTES
      ) {
        break;
      }
      const parsed = parseMcpResourceMention(mention, connectedServers);
      if (parsed === null) continue;

      try {
        const resolved = await runAdmittedSessionBoundToolCall<
          ResolvedMcpResource | null
        >({
          tool: MCP_RESOURCE_ATTACHMENT_ADMISSION_TOOL,
          args: { server: parsed.serverName, uri: parsed.uri },
          signal: deadline.signal,
          invoke: async ({ signal }) => {
            const combined = createCombinedAbortSignal(signal, {
              signalB: deadline.signal,
            });
            try {
              const resources = await getResourcesByServer(
                parsed.serverName,
                combined.signal,
              );
              combined.signal.throwIfAborted();
              const resource = resourceByUri(resources, parsed.uri);
              if (resource === null) return null;
              const content = await readResource(
                resource.namespacedName,
                combined.signal,
              );
              combined.signal.throwIfAborted();
              return content === null ? null : { resource, content };
            } finally {
              combined.cleanup();
            }
          },
          toDispatchResult: () => ({ content: "" }),
        });
        if (resolved === null) continue;
        // Count retained encoded strings, including base64, rather than trusting
        // decoded-byte metadata that can understate the attachment heap footprint.
        const resourceBytes = resourceRetainedBytes(resolved);
        if (
          resourceBytes >
          MCP_RESOURCE_ATTACHMENT_MAX_RETAINED_BYTES - retainedBytes
        ) {
          continue;
        }
        retainedBytes += resourceBytes;

        attachments.push({
          kind: "mcp_resource",
          server: parsed.serverName,
          uri: parsed.uri,
          name: resolved.resource.name ?? parsed.uri,
          ...(resolved.resource.description !== undefined
            ? { description: resolved.resource.description }
            : {}),
          content: resolved.content,
        });
      } catch (error) {
        if (opts.signal.aborted) throw opts.signal.reason ?? error;
        if (deadline.signal.aborted) break;
        continue;
      }
    }
  } finally {
    deadline.cleanup();
  }

  return attachments;
};
