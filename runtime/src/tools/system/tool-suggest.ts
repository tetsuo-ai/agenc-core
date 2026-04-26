/**
 * `tool_suggest` — verbatim port of codex's tool-suggestion discovery
 * surface (see `codex-rs/tools/src/tool_discovery.rs::create_tool_suggest_tool`).
 *
 * The runtime source-of-truth in codex is the inline `format!` in
 * `create_tool_suggest_tool`. The standalone
 * `core/templates/search_tool/tool_suggest_description.md` artifact is
 * NOT `include_str!`'d; only a unit test mentions the filename.
 *
 * The tool's purpose is to let the model recommend a missing
 * connector/plugin from the runtime's discoverable-tools list when no
 * available tool matches the user's request. The schema and description
 * mirror codex byte-for-byte; the `{discoverable_tools}` placeholder is
 * filled from `config.discoverableTools` (defaults to an empty list).
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";
import { codingToolMetadata, errorResult } from "./coding-common.js";

/** Verbatim from codex `TOOL_SUGGEST_TOOL_NAME`. */
export const TOOL_SUGGEST_TOOL_NAME = "tool_suggest";

/** Verbatim from codex `TOOL_SEARCH_TOOL_NAME`. Used inside the description. */
const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * Codex `DiscoverableToolType`. Either a connector (an installable app
 * with an `install_url`) or a plugin (a curated bundle of skills,
 * connectors, and MCP servers).
 */
export type DiscoverableToolType = "connector" | "plugin";

/**
 * Codex `ToolSuggestEntry` — the per-discoverable-tool record used to
 * populate the `{discoverable_tools}` placeholder in the description.
 */
export interface ToolSuggestEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly toolType: DiscoverableToolType;
  /** Codex plugin-only metadata. Ignored for connectors. */
  readonly hasSkills?: boolean;
  readonly mcpServerNames?: readonly string[];
  readonly appConnectorIds?: readonly string[];
}

export interface ToolSuggestConfig {
  /**
   * Live discoverable-tools catalog used to build the
   * `{discoverable_tools}` listing in the description and the
   * `tool_id` enum hint in the schema.
   *
   * TODO(codex-parity): wire this to a live runtime discoverable-tools
   * source (codex resolves this from the app server's connector +
   * plugin manifests). Today the AgenC tool registry has no such
   * source, so callers pass an empty list and the tool effectively
   * records the suggestion as metadata.
   */
  readonly discoverableTools?: readonly ToolSuggestEntry[];
}

/**
 * Verbatim port of codex `tool_description_or_fallback`
 * (tool_discovery.rs:385-399).
 */
function toolDescriptionOrFallback(tool: ToolSuggestEntry): string {
  const trimmed = tool.description?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  switch (tool.toolType) {
    case "connector":
      return "No description provided.";
    case "plugin":
      return pluginSummary(tool);
  }
}

/**
 * Verbatim port of codex `plugin_summary` (tool_discovery.rs:401-421).
 */
function pluginSummary(tool: ToolSuggestEntry): string {
  const details: string[] = [];
  if (tool.hasSkills === true) {
    details.push("skills");
  }
  if (tool.mcpServerNames && tool.mcpServerNames.length > 0) {
    details.push(`MCP servers: ${tool.mcpServerNames.join(", ")}`);
  }
  if (tool.appConnectorIds && tool.appConnectorIds.length > 0) {
    details.push(`app connectors: ${tool.appConnectorIds.join(", ")}`);
  }
  if (details.length === 0) {
    return "No description provided.";
  }
  return details.join("; ");
}

/**
 * Verbatim port of codex `format_discoverable_tools`
 * (tool_discovery.rs:361-383).
 */
function formatDiscoverableTools(
  discoverableTools: readonly ToolSuggestEntry[],
): string {
  const sorted = [...discoverableTools].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name);
    return left.id.localeCompare(right.id);
  });
  return sorted
    .map((tool) => {
      const description = toolDescriptionOrFallback(tool);
      return `- ${tool.name} (id: \`${tool.id}\`, type: ${tool.toolType}, action: install): ${description}`;
    })
    .join("\n");
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Build the `tool_suggest` tool. Mirrors codex
 * `create_tool_suggest_tool(discoverable_tools)` byte-for-byte.
 */
export function createToolSuggestTool(config: ToolSuggestConfig = {}): Tool {
  const discoverableTools = config.discoverableTools ?? [];
  const discoverableToolIds = discoverableTools
    .map((tool) => tool.id)
    .join(", ");
  const discoverableToolsList = formatDiscoverableTools(discoverableTools);

  // Verbatim from codex `create_tool_suggest_tool` lines 310-311.
  const description =
    `# Tool suggestion discovery\n\nSuggests a missing connector in an installed plugin, or in narrower cases a not installed but discoverable plugin, when the user clearly wants a capability that is not currently available in the active \`tools\` list.\n\nUse this ONLY when:\n- You've already tried to find a matching available tool for the user's request but couldn't find a good match. This includes \`${TOOL_SEARCH_TOOL_NAME}\` (if available) and other means.\n- For connectors/apps that are not installed but needed for an installed plugin, suggest to install them if the task requirements match precisely.\n- For plugins that are not installed but discoverable, only suggest discoverable and installable plugins when the user's intent very explicitly and unambiguously matches that plugin itself. Do not suggest a plugin just because one of its connectors or capabilities seems relevant.\n\nTool suggestions should only use the discoverable tools listed here. DO NOT explore or recommend tools that are not on this list.\n\nDiscoverable tools:\n${discoverableToolsList}\n\nWorkflow:\n\n1. Ensure all possible means have been exhausted to find an existing available tool but none of them matches the request intent.\n2. Match the user's request against the discoverable tools list above. Apply the stricter explicit-and-unambiguous rule for *discoverable tools* like plugin install suggestions; *missing tools* like connector install suggestions continue to use the normal clear-fit standard.\n3. If one tool clearly fits, call \`${TOOL_SUGGEST_TOOL_NAME}\` with:\n   - \`tool_type\`: \`connector\` or \`plugin\`\n   - \`action_type\`: \`install\` or \`enable\`\n   - \`tool_id\`: exact id from the discoverable tools list above\n   - \`suggest_reason\`: concise one-line user-facing reason this tool can help with the current request\n4. After the suggestion flow completes:\n   - if the user finished the install or enable flow, continue by searching again or using the newly available tool\n   - if the user did not finish, continue without that tool, and don't suggest that tool again unless the user explicitly asks for it.`;

  return {
    name: TOOL_SUGGEST_TOOL_NAME,
    description,
    metadata: {
      ...codingToolMetadata(TOOL_SUGGEST_TOOL_NAME, false, [
        "coding",
        "general",
        "operator",
      ]),
      keywords: ["tools", "suggest", "discovery", "connector", "plugin"],
    },
    inputSchema: {
      type: "object",
      properties: {
        // Verbatim descriptions from codex tool_discovery.rs lines 282-306.
        tool_type: {
          type: "string",
          description:
            'Type of discoverable tool to suggest. Use "connector" or "plugin".',
        },
        action_type: {
          type: "string",
          description:
            'Suggested action for the tool. Use "install" or "enable".',
        },
        tool_id: {
          type: "string",
          description: `Connector or plugin id to suggest. Must be one of: ${discoverableToolIds}.`,
        },
        suggest_reason: {
          type: "string",
          description:
            "Concise one-line user-facing reason why this tool can help with the current request.",
        },
      },
      required: ["tool_type", "action_type", "tool_id", "suggest_reason"],
      additionalProperties: false,
    },
    async execute(args) {
      const toolType = toOptionalString(args.tool_type);
      const actionType = toOptionalString(args.action_type);
      const toolId = toOptionalString(args.tool_id);
      const suggestReason = toOptionalString(args.suggest_reason);

      if (!toolType) {
        return errorResult("tool_type must be a non-empty string");
      }
      if (toolType !== "connector" && toolType !== "plugin") {
        return errorResult(
          'tool_type must be either "connector" or "plugin"',
        );
      }
      if (!actionType) {
        return errorResult("action_type must be a non-empty string");
      }
      if (actionType !== "install" && actionType !== "enable") {
        return errorResult(
          'action_type must be either "install" or "enable"',
        );
      }
      if (!toolId) {
        return errorResult("tool_id must be a non-empty string");
      }
      if (!suggestReason) {
        return errorResult("suggest_reason must be a non-empty string");
      }

      // Plain-text content (matches codex `tool_suggest` semantics:
      // the tool surfaces a suggestion to the user, it does not return
      // structured JSON to the model).
      const matched = discoverableTools.find((tool) => tool.id === toolId);
      const displayName = matched?.name ?? toolId;
      const summary = `Suggested ${toolType} \`${toolId}\`${matched ? ` (${displayName})` : ""} with action \`${actionType}\`: ${suggestReason}`;
      const result: ToolResult = {
        content: summary,
        metadata: {
          tool_type: toolType,
          action_type: actionType,
          tool_id: toolId,
          suggest_reason: suggestReason,
          ...(matched ? { matched_name: matched.name } : {}),
        },
      };
      return result;
    },
  };
}
