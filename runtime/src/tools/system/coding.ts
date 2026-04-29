import { resolve as resolvePath } from "node:path";

import { runCommand } from "../../utils/process.js";
import type { Tool } from "../types.js";
import {
  appendRipgrepPathFilters,
  codingToolMetadata,
  DEFAULT_CONTEXT_LINES,
  describeRipgrepFailure,
  ensureRipgrepAvailable,
  errorResult,
  listSearchTargetFiles,
  MAX_RESULTS,
  MAX_RIPGREP_BUFFER,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  okResult,
  readTextFile,
  resolveSearchGlobPatterns,
  resolveSearchTarget,
  type CodingToolConfig,
} from "./coding-common.js";
import { createGitAndRepoTools } from "./git-tools.js";
import { createSymbolTools } from "./symbol-tools.js";
import { createToolSearchTool } from "./tool-search.js";

export {
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
} from "./coding-common.js";
export type { CodingToolConfig } from "./coding-common.js";

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function collectMatchSnippets(params: {
  readonly lines: readonly string[];
  readonly matchLineIndex: number;
  readonly before: number;
  readonly after: number;
}): string[] {
  const start = Math.max(0, params.matchLineIndex - params.before);
  const end = Math.min(params.lines.length - 1, params.matchLineIndex + params.after);
  const snippets: string[] = [];
  for (let index = start; index <= end; index += 1) {
    snippets.push(params.lines[index] ?? "");
  }
  return snippets;
}

async function collectFileContextSnippet(params: {
  readonly searchRoot: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly contextLines: number;
  readonly cache: Map<string, readonly string[]>;
}): Promise<readonly string[]> {
  if (params.contextLines === 0) {
    const cached = params.cache.get(params.relativePath);
    if (cached) {
      return [cached[Math.max(0, params.lineNumber - 1)] ?? ""];
    }
  }
  let lines = params.cache.get(params.relativePath);
  if (!lines) {
    const text = await readTextFile(resolvePath(params.searchRoot, params.relativePath));
    lines = text ? text.split(/\r?\n/) : [];
    params.cache.set(params.relativePath, lines);
  }
  if (lines.length === 0) return [];
  return collectMatchSnippets({
    lines,
    matchLineIndex: Math.max(0, params.lineNumber - 1),
    before: params.contextLines,
    after: params.contextLines,
  });
}

export function createCodingTools(config: CodingToolConfig): readonly Tool[] {
  const grepTool: Tool = {
    name: "system.grep",
    description:
      "Search path-scoped files for content matches using ripgrep behind a native structured grep surface. Prefer this over raw shell grep/rg for coding workflows.",
    metadata: codingToolMetadata("system.grep"),
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
        caseSensitive: { type: "boolean" },
        regex: { type: "boolean", description: "Treat pattern as a regex. Defaults to false." },
        glob: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        filePatterns: { type: "array", items: { type: "string" } },
        type: { type: "string", description: "Optional ripgrep file type filter (for example ts, js, py)." },
        contextLines: { type: "integer", minimum: 0, maximum: 10 },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        headLimit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        offset: { type: "integer", minimum: 0, maximum: 10_000 },
        outputMode: { type: "string", description: "Optional additive output mode: matches (default), content, or count." },
        multiline: { type: "boolean", description: "Enable multiline ripgrep mode. Supported only when outputMode is content." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args) {
      const pattern = toOptionalString(args.pattern);
      if (!pattern) return errorResult("pattern must be a non-empty string");
      const target = await resolveSearchTarget({
        config,
        args,
        pathArgKeys: ["path"],
      });
      if ("error" in target) {
        return errorResult(target.error);
      }
      const missingRipgrep = await ensureRipgrepAvailable(target.searchRoot);
      if (missingRipgrep) return errorResult(missingRipgrep);
      const outputMode = toOptionalString(args.outputMode) ?? "matches";
      if (!["matches", "content", "count"].includes(outputMode)) {
        return errorResult("outputMode must be one of matches, content, or count");
      }
      if (args.multiline === true && outputMode !== "content") {
        return errorResult("multiline is only supported when outputMode is content");
      }
      const contextLines = normalizeNonNegativeInteger(
        args.contextLines,
        DEFAULT_CONTEXT_LINES,
        10,
      );
      const globPatterns = resolveSearchGlobPatterns(args);
      const type = toOptionalString(args.type);
      const headLimit = normalizePositiveInteger(
        args.headLimit ?? args.maxResults,
        normalizePositiveInteger(args.maxResults, 50, MAX_RESULTS),
        MAX_RESULTS,
      );
      const offset = normalizeNonNegativeInteger(args.offset, 0, 10_000);
      const baseArgs = ["--hidden", "--max-columns", "500"];
      appendRipgrepPathFilters(baseArgs, { globPatterns, type });
      if (args.caseSensitive !== true) {
        baseArgs.push("-i");
      }
      if (args.multiline === true) {
        baseArgs.push("-U", "--multiline-dotall");
      }
      if (args.regex !== true) {
        baseArgs.push("-F");
      }
      const patternArgs = pattern.startsWith("-") ? ["-e", pattern] : [pattern];

      if (outputMode === "content") {
        const rgArgs = [...baseArgs, "-n"];
        if (contextLines > 0) {
          rgArgs.push("-C", String(contextLines));
        }
        rgArgs.push(...patternArgs, target.targetArg);
        const result = await runCommand("rg", rgArgs, {
          cwd: target.searchRoot,
          maxBuffer: MAX_RIPGREP_BUFFER,
        });
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return errorResult(describeRipgrepFailure(result, "ripgrep search failed"));
        }
        const lines = result.stdout
          .replace(/\s+$/, "")
          .split(/\r?\n/)
          .filter((line) => line.length > 0);
        const pagedLines = lines.slice(offset, offset + headLimit);
        return okResult({
          repoRoot: target.searchRoot,
          searchRoot: target.searchRoot,
          searchPath: target.searchPath,
          pattern,
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
          outputMode,
          multiline: args.multiline === true,
          appliedLimit: headLimit,
          appliedOffset: offset,
          truncated: lines.length > offset + pagedLines.length,
          content: pagedLines.join("\n"),
        });
      }

      const rgArgs = [
        ...baseArgs,
        "--json",
        "--line-number",
        "--column",
        ...patternArgs,
        target.targetArg,
      ];
      const result = await runCommand("rg", rgArgs, {
        cwd: target.searchRoot,
        maxBuffer: MAX_RIPGREP_BUFFER,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return errorResult(describeRipgrepFailure(result, "ripgrep search failed"));
      }
      const snippetCache = new Map<string, readonly string[]>();
      const matches: {
        filePath: string;
        line: number;
        column: number;
        matchText: string;
        snippet: readonly string[];
      }[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type !== "match") continue;
        const data =
          typeof event.data === "object" && event.data !== null
            ? (event.data as Record<string, unknown>)
            : undefined;
        const pathData =
          typeof data?.path === "object" && data.path !== null
            ? (data.path as Record<string, unknown>)
            : undefined;
        const relativePath =
          typeof pathData?.text === "string"
            ? pathData.text.replace(/^\.\//, "")
            : typeof pathData?.bytes === "string"
              ? Buffer.from(pathData.bytes, "base64").toString("utf8").replace(/^\.\//, "")
              : undefined;
        const lineNumber =
          typeof data?.line_number === "number" ? data.line_number : undefined;
        const submatches = Array.isArray(data?.submatches)
          ? data.submatches.filter(
              (entry): entry is Record<string, unknown> =>
                typeof entry === "object" && entry !== null,
            )
          : [];
        if (!relativePath || !lineNumber || submatches.length === 0) {
          continue;
        }
        const snippet = await collectFileContextSnippet({
          searchRoot: target.searchRoot,
          relativePath,
          lineNumber,
          contextLines,
          cache: snippetCache,
        });
        for (const submatch of submatches) {
          const column =
            typeof submatch.start === "number" ? submatch.start + 1 : 1;
          const matchText =
            typeof submatch.match === "object" &&
            submatch.match !== null &&
            typeof (submatch.match as { text?: unknown }).text === "string"
              ? (submatch.match as { text: string }).text
              : "";
          matches.push({
            filePath: relativePath,
            line: lineNumber,
            column,
            matchText,
            snippet,
          });
        }
      }
      const pagedMatches = matches.slice(offset, offset + headLimit);
      if (outputMode === "count") {
        const fileCount = new Set(matches.map((match) => match.filePath)).size;
        return okResult({
          repoRoot: target.searchRoot,
          searchRoot: target.searchRoot,
          searchPath: target.searchPath,
          pattern,
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
          outputMode,
          appliedLimit: headLimit,
          appliedOffset: offset,
          numFiles: fileCount,
          numMatches: matches.length,
          truncated: matches.length > offset + pagedMatches.length,
          content: `Found ${matches.length} ${matches.length === 1 ? "match" : "matches"} across ${fileCount} ${fileCount === 1 ? "file" : "files"}.`,
        });
      }
      return okResult({
        repoRoot: target.searchRoot,
        searchRoot: target.searchRoot,
        searchPath: target.searchPath,
        pattern,
        regex: args.regex === true,
        caseSensitive: args.caseSensitive === true,
        appliedLimit: headLimit,
        appliedOffset: offset,
        truncated: matches.length > offset + pagedMatches.length,
        matches: pagedMatches,
      });
    },
  };

  const globTool: Tool = {
    name: "system.glob",
    description:
      "Match path-scoped files by glob pattern using ripgrep's file listing surface.",
    metadata: codingToolMetadata("system.glob"),
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args) {
      const pattern = toOptionalString(args.pattern);
      if (!pattern) return errorResult("pattern must be a non-empty string");
      const target = await resolveSearchTarget({ config, args, pathArgKeys: ["path"] });
      if ("error" in target) return errorResult(target.error);
      const listed = await listSearchTargetFiles({
        target,
        globPatterns: [pattern],
      });
      if ("error" in listed) return errorResult(listed.error);
      return okResult({
        repoRoot: listed.searchRoot,
        searchRoot: listed.searchRoot,
        searchPath: listed.searchPath,
        pattern,
        matches: listed.matches.slice(
          0,
          normalizePositiveInteger(args.maxResults, 100, MAX_RESULTS),
        ),
      });
    },
  };

  const tools: Tool[] = [grepTool, globTool];
  if (config.codeIntelligenceTools === true) {
    tools.push(...createGitAndRepoTools(config), ...createSymbolTools(config));
  }
  tools.push(createToolSearchTool(config));
  return tools;
}
