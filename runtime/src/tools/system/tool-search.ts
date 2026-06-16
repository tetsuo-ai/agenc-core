import type { Tool, ToolCatalogEntry } from "../types.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "../../llm/wire/mcp-tool-naming.js";
import { sanitizeSystemReminderContent } from "../../prompts/attachments/system-reminder-sanitizer.js";
import {
  codingToolMetadata,
  MAX_RESULTS,
  normalizePositiveInteger,
  okResult,
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
  toOptionalString,
  type CodingToolConfig,
} from "./coding-common.js";

function splitSearchTokens(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function parseToolSearchQuery(rawQuery?: string): {
  readonly query?: string;
  readonly selections: readonly string[];
} {
  if (!rawQuery) return { selections: [] };
  const selections: string[] = [];
  const remaining: string[] = [];
  for (const token of rawQuery.split(/\s+/)) {
    const trimmed = token.trim();
    if (trimmed.toLowerCase().startsWith("select:")) {
      const selected = trimmed.slice("select:".length);
      for (const name of selected.split(",")) {
        const normalized = name.trim();
        if (normalized.length > 0) selections.push(normalized);
      }
      continue;
    }
    if (trimmed.length > 0) remaining.push(trimmed);
  }
  return {
    query: remaining.join(" ").trim() || undefined,
    selections,
  };
}

function scoreCatalogEntry(entry: ToolCatalogEntry, query?: string): number {
  if (!query) return 10;
  const lowered = query.toLowerCase();
  const entryName = entry.name.toLowerCase();
  const family = entry.metadata.family.toLowerCase();
  const source = entry.metadata.source.toLowerCase();
  const keywords = entry.metadata.keywords?.map((keyword) => keyword.toLowerCase()) ?? [];
  const haystack = [
    entryName,
    entry.description.toLowerCase(),
    family,
    source,
    ...keywords,
    ...(entry.metadata.preferredProfiles?.map((profile) => profile.toLowerCase()) ?? []),
  ];
  if (entryName === lowered) return 0;
  if (entryName.startsWith(lowered)) return 1;
  if (keywords.some((keyword) => keyword === lowered)) return 2;
  if (family === lowered || source === lowered) return 3;
  const tokens = splitSearchTokens(query);
  if (tokens.length > 0 && tokens.every((token) => haystack.some((part) => part.includes(token)))) {
    return 4;
  }
  if (entry.description.toLowerCase().includes(lowered)) return 5;
  if (keywords.some((keyword) => keyword.includes(lowered))) return 6;
  return 99;
}

function matchesCatalogQuery(entry: ToolCatalogEntry, query?: string): boolean {
  if (!query) return true;
  return scoreCatalogEntry(entry, query) < 99;
}

function mcpUseHint(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp.")) return undefined;
  const wireName = encodeMcpToolNameForWire(toolName);
  const nameHint =
    wireName === toolName
      ? `Call the selected MCP tool through the tool-call interface as ${toolName}, with JSON arguments.`
      : `Call the selected MCP tool through the tool-call interface using the available function ${wireName}; the runtime maps it to ${toolName}.`;
  return `${nameHint} The selected MCP function is now available; make that tool call directly as your next action when the user asked for it. It is not a shell command and not a skill. Do not use exec_command, Skill, echo, or any shell/script placeholder as a note to yourself before calling it.`;
}

function modelFacingToolSearchText(value: string): string {
  return sanitizeSystemReminderContent(value);
}

function modelFacingToolSearchStrings(
  values: readonly string[] | undefined,
): string[] | undefined {
  return values?.map(modelFacingToolSearchText);
}

function modelFacingToolSearchMetadata(
  metadata: ToolCatalogEntry["metadata"],
): Record<string, unknown> {
  return {
    family: modelFacingToolSearchText(metadata.family),
    source: modelFacingToolSearchText(metadata.source),
    hiddenByDefault: metadata.hiddenByDefault,
    mutating: metadata.mutating,
    deferred: metadata.deferred,
    ...(metadata.keywords !== undefined
      ? { keywords: modelFacingToolSearchStrings(metadata.keywords) }
      : {}),
    ...(metadata.preferredProfiles !== undefined
      ? {
          preferredProfiles: modelFacingToolSearchStrings(
            metadata.preferredProfiles,
          ),
        }
      : {}),
  };
}

function normalizeSelections(args: Record<string, unknown>): readonly string[] {
  const parsedQuery = parseToolSearchQuery(toOptionalString(args.query));
  return [
    ...parsedQuery.selections,
    ...(
      typeof args.select === "string"
        ? [args.select]
        : Array.isArray(args.select)
          ? args.select.filter((entry): entry is string => typeof entry === "string")
          : []
    ),
  ]
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
}

function mcpServerPrefixForSelection(selection: string): string | undefined {
  if (!selection.startsWith("mcp.") && !selection.includes(".")) {
    return `mcp.${selection}.`;
  }
  if (selection.startsWith("mcp.") && selection.slice("mcp.".length).split(".").length === 1) {
    return `${selection}.`;
  }
  return undefined;
}

function resolveSelection(
  selection: string,
  catalog: readonly ToolCatalogEntry[],
): ToolCatalogEntry | undefined {
  const decoded = decodeMcpToolNameFromWire(selection);
  const exact = catalog.find((entry) => entry.name === decoded);
  if (exact) return exact;

  const mcpServerPrefix = mcpServerPrefixForSelection(decoded);
  if (!mcpServerPrefix) return undefined;
  const mcpServerMatches = catalog.filter((entry) =>
    entry.name.startsWith(mcpServerPrefix),
  );
  return mcpServerMatches.length === 1 ? mcpServerMatches[0] : undefined;
}

export function createToolSearchTool(config: CodingToolConfig): Tool {
  return {
    name: "system.searchTools",
    description:
      "Search the runtime tool catalog by name, family, source, keyword, or preferred profile. Use select or select:<tool_name> to load a deferred tool schema.",
    metadata: {
      ...codingToolMetadata("system.searchTools", false, ["coding", "general", "operator"]),
      keywords: ["tools", "catalog", "discovery", "select", "deferred"],
      virtualNoFsWrites: true,
    },
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search terms. May include AgenC-style select:<tool_name> to load an exact deferred tool.",
        },
        select: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Exact tool name or names to load. Equivalent to query token select:<tool_name>.",
        },
        family: { type: "string" },
        source: { type: "string" },
        profile: { type: "string" },
        includeHidden: { type: "boolean" },
        advertisedOnly: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const catalog = config.getToolCatalog?.() ?? [];
      const parsedQuery = parseToolSearchQuery(toOptionalString(args.query));
      const query = parsedQuery.query;
      const explicitSelections = normalizeSelections(args);
      const selectedEntries = explicitSelections
        .map((name) => resolveSelection(name, catalog))
        .filter((entry): entry is ToolCatalogEntry => entry !== undefined);
      const missingSelections = explicitSelections.filter(
        (name) => resolveSelection(name, catalog) === undefined,
      );
      const family = toOptionalString(args.family);
      const source = toOptionalString(args.source);
      const profile = toOptionalString(args.profile);
      const advertisedToolNames = Array.isArray(args[SESSION_ADVERTISED_TOOL_NAMES_ARG])
        ? new Set(
            (args[SESSION_ADVERTISED_TOOL_NAMES_ARG] as unknown[])
              .filter((value): value is string => typeof value === "string"),
          )
        : undefined;
      const matchedResults = catalog
        .filter((entry) => {
          if (args.includeHidden !== true && entry.metadata.hiddenByDefault) return false;
          if (args.advertisedOnly === true && advertisedToolNames && !advertisedToolNames.has(entry.name)) {
            return false;
          }
          if (family && entry.metadata.family !== family) return false;
          if (source && entry.metadata.source !== source) return false;
          if (
            profile &&
            entry.metadata.preferredProfiles &&
            !entry.metadata.preferredProfiles.includes(profile)
          ) {
            return false;
          }
          return matchesCatalogQuery(entry, query);
        })
        .sort((left, right) => {
          const leftScore = scoreCatalogEntry(left, query);
          const rightScore = scoreCatalogEntry(right, query);
          if (leftScore !== rightScore) return leftScore - rightScore;
          return left.name.localeCompare(right.name);
        })
        .slice(0, normalizePositiveInteger(args.maxResults, 50, MAX_RESULTS));
      const results = [
        ...selectedEntries,
        ...matchedResults,
      ].filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.name === entry.name) === index,
      );
      const loaded = selectedEntries.map((entry) => entry.name);
      if (loaded.length > 0) {
        config.onDiscoverTools?.(loaded);
      }

      return okResult({
        totalCatalogSize: catalog.length,
        loaded: loaded.map(modelFacingToolSearchText),
        missingSelections: missingSelections.map(modelFacingToolSearchText),
        results: results.map((entry) => {
          const selected = selectedEntries.some(
            (candidate) => candidate.name === entry.name,
          );
          const useHint = mcpUseHint(entry.name);
          return {
            name: modelFacingToolSearchText(entry.name),
            description: modelFacingToolSearchText(entry.description),
            metadata: modelFacingToolSearchMetadata(entry.metadata),
            advertised: advertisedToolNames?.has(entry.name) ?? false,
            selected,
            loadHint:
              entry.metadata.deferred && !selected
                ? modelFacingToolSearchText(
                    `Call system.searchTools with select:${entry.name} to load this deferred tool.`,
                  )
                : undefined,
            useHint:
              useHint !== undefined
                ? modelFacingToolSearchText(useHint)
                : undefined,
          };
        }),
      });
    },
  };
}
