import type { Tool, ToolCatalogEntry } from "../types.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "../../llm/wire/mcp-tool-naming.js";
import { sanitizeSystemReminderContent } from "../../prompts/attachments/system-reminder-sanitizer.js";
import { SYSTEM_SEARCH_TOOLS_NAME } from "./tool-search-name.js";
import {
  codingToolMetadata,
  MAX_RESULTS,
  normalizePositiveInteger,
  okResult,
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
  SESSION_TOOL_CATALOG_SCOPE_ARG,
  toOptionalString,
  type CodingToolConfig,
} from "./coding-common.js";

function splitSearchTokens(query: string): readonly string[] {
  return [...new Set(query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0))];
}

// Small vocabulary bridges, applied to both names and catalog descriptions.
// Keep explicit identities and filters literal; these only rank search results.
const RELATED_SEARCH_TERMS: readonly (readonly string[])[] = [
  ["web", "internet", "online"],
  ["search", "find", "lookup"],
  ["fetch", "retrieve", "download"],
  ["page", "webpage"],
  ["file", "files", "filesystem"],
  ["directory", "directories", "folder", "folders"],
  ["skill", "skills"],
];
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "or", "the", "to", "for", "of", "with", "using"]);
type CatalogSearchScore = readonly [priority: number, matches: number, direct: number, name: number];

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

function scoreCatalogEntry(
  entry: ToolCatalogEntry,
  query: string | undefined,
  tokens: readonly string[],
): CatalogSearchScore | undefined {
  if (!query) return [10, 0, 0, 0];
  const lowered = query.toLowerCase();
  const entryName = entry.name.toLowerCase();
  const family = entry.metadata.family.toLowerCase();
  const source = entry.metadata.source.toLowerCase();
  const keywords = entry.metadata.keywords?.map((keyword) => keyword.toLowerCase()) ?? [];
  const haystack = [
    entryName,
    splitSearchTokens(entry.name).join(" "),
    entry.description.toLowerCase(),
    family,
    source,
    ...keywords,
    ...(entry.metadata.preferredProfiles?.map((profile) => profile.toLowerCase()) ?? []),
  ];
  if (entryName === lowered) return [0, 0, 0, 0];
  if (entryName.startsWith(lowered)) return [1, 0, 0, 0];
  if (keywords.some((keyword) => keyword === lowered)) return [2, 0, 0, 0];
  if (family === lowered || source === lowered) return [3, 0, 0, 0];
  const words = new Set(haystack.flatMap(splitSearchTokens));
  let matches = 0;
  let direct = 0;
  let name = 0;
  for (const token of tokens) {
    if (haystack.some((part) => part.includes(token))) {
      matches++;
      direct++;
      if (entryName.includes(token)) name++;
    } else {
      const related = RELATED_SEARCH_TERMS.find((terms) => terms.includes(token));
      if (related?.some((term) => words.has(term))) matches++;
    }
  }
  // Coverage wins, then literal matches, then matches in the tool's identity.
  // A mixed-intent query can find several useful tools without matching every word.
  return matches > 0 ? [4, matches, direct, name] : undefined;
}

function mcpUseHint(toolName: string, available: boolean): string | undefined {
  if (!toolName.startsWith("mcp.")) return undefined;
  const wireName = encodeMcpToolNameForWire(toolName);
  if (!available) {
    return `This MCP function is not loaded yet. First call system.searchTools with {"select":"${toolName}"} to load its argument schema. Do not call it or guess its arguments before loading. After loading, use the function ${wireName}; the runtime maps it to ${toolName}. It is not a shell command or a skill.`;
  }
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
  const decoded = decodeMcpToolNameFromWire(
    selection,
    catalog.map((entry) => entry.name),
  );
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
    name: SYSTEM_SEARCH_TOOLS_NAME,
    description:
      "Find and load tools that are not in your function list. select (or select:<tool_name> in query) loads a tool's schema by its exact name; query and the filters search the catalog by name, family, source, keyword or profile.",
    metadata: {
      ...codingToolMetadata(SYSTEM_SEARCH_TOOLS_NAME, false, ["coding", "general", "operator"]),
      keywords: ["tools", "catalog", "discovery", "select", "deferred"],
      virtualNoFsWrites: true,
    },
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms; may include select:<tool_name>.",
        },
        select: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "Exact tool name or names to load.",
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
      await config.onBeforeSearch?.();
      // A subagent shares this tool with its parent's registry but cannot call
      // MCP, disabled or out-of-allowlist tools. Never offer or load those.
      const scope = Array.isArray(args[SESSION_TOOL_CATALOG_SCOPE_ARG])
        ? new Set(args[SESSION_TOOL_CATALOG_SCOPE_ARG] as unknown[])
        : undefined;
      const catalog = (config.getToolCatalog?.() ?? [])
        .filter((entry) => scope === undefined || scope.has(entry.name));
      const parsedQuery = parseToolSearchQuery(toOptionalString(args.query));
      const query = parsedQuery.query;
      const searchTokens = splitSearchTokens(query ?? "").filter((token) => !SEARCH_STOP_WORDS.has(token));
      const explicitSelections = normalizeSelections(args);
      const selectedEntries = explicitSelections
        .map((name) => resolveSelection(name, catalog))
        .filter((entry): entry is ToolCatalogEntry => entry !== undefined)
        .filter((entry, index, all) => all.findIndex(candidate => candidate.name === entry.name) === index);
      const missingSelections = explicitSelections.filter(
        (name) => resolveSelection(name, catalog) === undefined,
      );
      const family = toOptionalString(args.family);
      const source = toOptionalString(args.source);
      const profile = toOptionalString(args.profile);
      const selectionOnly = explicitSelections.length > 0 && !query &&
        !family && !source && !profile && args.includeHidden !== true && args.advertisedOnly !== true;
      // Loading a schema is not an implicit request to browse the catalog.
      // Preserve scoped candidates for an ambiguous MCP server selection, but
      // never append unrelated tools (or load an ambiguous candidate).
      const suggestionPrefixes = selectionOnly
        ? missingSelections.map(mcpServerPrefixForSelection)
          .filter((prefix): prefix is string => prefix !== undefined)
        : [];
      const searchCatalog = selectionOnly
        ? catalog.filter(entry => suggestionPrefixes.some(prefix => entry.name.startsWith(prefix)))
        : catalog;
      const advertisedToolNames = Array.isArray(args[SESSION_ADVERTISED_TOOL_NAMES_ARG])
        ? new Set(
            (args[SESSION_ADVERTISED_TOOL_NAMES_ARG] as unknown[])
              .filter((value): value is string => typeof value === "string"),
          )
        : undefined;
      const matchedResults = searchCatalog
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
          return true;
        })
        .map((entry) => ({ entry, score: scoreCatalogEntry(entry, query, searchTokens) }))
        .filter((match): match is { entry: ToolCatalogEntry; score: CatalogSearchScore } => match.score !== undefined)
        .sort((left, right) => {
          return left.score[0] - right.score[0] ||
            right.score[1] - left.score[1] || right.score[2] - left.score[2] ||
            right.score[3] - left.score[3] || left.entry.name.localeCompare(right.entry.name);
        })
        .slice(0, normalizePositiveInteger(args.maxResults, query ? 5 : 50, MAX_RESULTS))
        .map(({ entry }) => entry);
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
          const advertised = advertisedToolNames?.has(entry.name) ?? false;
          const useHint = mcpUseHint(entry.name, selected || advertised);
          return {
            name: modelFacingToolSearchText(entry.name),
            description: modelFacingToolSearchText(entry.description),
            metadata: modelFacingToolSearchMetadata(entry.metadata),
            advertised,
            selected,
            loadHint:
              !selected && !advertised && (advertisedToolNames !== undefined || entry.metadata.deferred)
                ? modelFacingToolSearchText(
                    `Call system.searchTools with select:${entry.name} to load this ${entry.metadata.deferred ? "deferred tool" : "tool's argument schema"}.`,
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
