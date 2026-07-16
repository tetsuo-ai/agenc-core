import { resolve as resolvePath } from "node:path";

import { silentLogger } from "../../utils/logger.js";
import type { Tool } from "../types.js";
import {
  CodeIntelManager,
  toRelativeWorkspacePath,
} from "./code-intel.js";
import {
  codingToolMetadata,
  errorResult,
  MAX_RESULTS,
  normalizePositiveInteger,
  okResult,
  resolveRepoRoot,
  toOptionalString,
  type CodingToolConfig,
} from "./coding-common.js";

export function createSymbolTools(config: CodingToolConfig): readonly Tool[] {
  const codeIntel = new CodeIntelManager({
    persistenceRootDir: config.persistenceRootDir,
    logger: config.logger ?? silentLogger,
  });

  const symbolSearchTool: Tool = {
    name: "system.symbolSearch",
    description: "Search semantic repo symbols from the native code-intel index.",
    metadata: codingToolMetadata("system.symbolSearch", false, ["coding", "review"], {
      family: "symbol",
      deferred: true,
      keywords: ["symbol", "search", "definition", "code-intel"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        language: { type: "string" },
        kind: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const symbols = await codeIntel.searchSymbols({
        workspaceRoot: repoRoot,
        toolArgs: args,
        query: toOptionalString(args.query),
        language: toOptionalString(args.language),
        kind: toOptionalString(args.kind),
        maxResults: normalizePositiveInteger(args.maxResults, 50, MAX_RESULTS),
      });
      return okResult({
        repoRoot,
        symbols: symbols.map((symbol) => ({
          ...symbol,
          filePath: toRelativeWorkspacePath(repoRoot, symbol.filePath),
        })),
      });
    },
  };

  const symbolDefinitionTool: Tool = {
    name: "system.symbolDefinition",
    description: "Return the best matching symbol definition from the native code-intel index.",
    metadata: codingToolMetadata("system.symbolDefinition", false, ["coding", "review"], {
      family: "symbol",
      deferred: true,
      keywords: ["symbol", "definition", "goto", "code-intel"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        path: { type: "string" },
        filePath: { type: "string" },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    async execute(args) {
      const symbol = toOptionalString(args.symbol);
      if (!symbol) return errorResult("symbol must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path", "filePath"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const filePath = toOptionalString(args.filePath);
      const definition = await codeIntel.getDefinition({
        workspaceRoot: repoRoot,
        toolArgs: args,
        symbolName: symbol,
        ...(filePath ? { filePath: resolvePath(repoRoot, filePath) } : {}),
      });
      if (!definition) {
        return errorResult(`No definition found for symbol "${symbol}"`);
      }
      return okResult({
        repoRoot,
        definition: {
          ...definition,
          filePath: toRelativeWorkspacePath(repoRoot, definition.filePath),
        },
      });
    },
  };

  const symbolReferencesTool: Tool = {
    name: "system.symbolReferences",
    description: "Return repo-local references for a symbol from the native code-intel index.",
    metadata: codingToolMetadata("system.symbolReferences", false, ["coding", "review"], {
      family: "symbol",
      deferred: true,
      keywords: ["symbol", "references", "usages", "code-intel"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        path: { type: "string" },
        filePath: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    async execute(args) {
      const symbol = toOptionalString(args.symbol);
      if (!symbol) return errorResult("symbol must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path", "filePath"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const filePath = toOptionalString(args.filePath);
      const refs = await codeIntel.getReferences({
        workspaceRoot: repoRoot,
        toolArgs: args,
        symbolName: symbol,
        ...(filePath ? { filePath: resolvePath(repoRoot, filePath) } : {}),
        maxResults: normalizePositiveInteger(args.maxResults, 100, 500),
      });
      return okResult({
        repoRoot,
        symbol,
        references: refs.map((entry) => ({
          ...entry,
          filePath: toRelativeWorkspacePath(repoRoot, entry.filePath),
        })),
      });
    },
  };

  return [symbolSearchTool, symbolDefinitionTool, symbolReferencesTool];
}
