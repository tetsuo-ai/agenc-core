import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  resolveToolAllowedPaths,
  safePath,
} from "./filesystem.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PATCH_PATH_HEADER =
  /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/u;
const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. It is not a git unified diff. Do not pass \`diff --git\`, \`--- a/file\`, or \`+++ b/file\` hunks to this tool.

Every patch must use this envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, every file operation starts with one of these headers:

*** Add File: <path> - create a new file. Every following line is a + line.
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place.

An update may be immediately followed by:

*** Move to: <new path>

Then one or more hunks, each introduced by @@. Within a hunk, every line starts with a space, -, or +.

The grammar is:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

Example:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Important:
- Include an Add/Delete/Update header for every file operation.
- Prefix new lines with +, including every line when creating a file.
- File references must be relative, never absolute.
- Put the complete patch body in the patch argument.`;

interface AddFileOperation {
  readonly kind: "add";
  readonly path: string;
  readonly content: string;
}

interface DeleteFileOperation {
  readonly kind: "delete";
  readonly path: string;
}

interface UpdateChunk {
  readonly changeContext?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly isEndOfFile: boolean;
}

interface UpdateFileOperation {
  readonly kind: "update";
  readonly path: string;
  readonly movePath?: string;
  readonly chunks: readonly UpdateChunk[];
}

type PatchOperation =
  | AddFileOperation
  | DeleteFileOperation
  | UpdateFileOperation;

interface ParsedChunk {
  readonly chunk: UpdateChunk;
  readonly parsedLines: number;
}

interface ParsedOperation {
  readonly operation: PatchOperation;
  readonly parsedLines: number;
}

interface AffectedPaths {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
}

export interface ApplyPatchRunnerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly errorCode?: string;
}

export type ApplyPatchRunner = (opts: {
  readonly patch: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}) => Promise<ApplyPatchRunnerResult>;

export interface ApplyPatchToolConfig {
  readonly allowedPaths: readonly string[];
  readonly runner?: ApplyPatchRunner;
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function textResult(content: string): ToolResult {
  return { content: content.length > 0 ? content : "Patch applied." };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function isOperationMarker(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "*** End Patch" ||
    trimmed.startsWith("*** Add File: ") ||
    trimmed.startsWith("*** Delete File: ") ||
    trimmed.startsWith("*** Update File: ")
  );
}

function normalizeAddFileLines(patch: string): string {
  const lines = patch.split("\n");
  const normalized: string[] = [];
  let insideAddFile = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("*** Add File: ")) {
      insideAddFile = true;
      normalized.push(line);
      continue;
    }
    if (isOperationMarker(line)) {
      insideAddFile = false;
      normalized.push(line);
      continue;
    }
    if (insideAddFile && !line.startsWith("+")) {
      normalized.push(`+${line}`);
      continue;
    }
    normalized.push(line);
  }

  return normalized.join("\n");
}

function normalizePatchEnvelope(patch: string): string {
  let normalized = patch.replace(/\r\n?/gu, "\n").trimEnd();
  if (
    !normalized.includes("*** End Patch") &&
    normalized.startsWith("*** Begin Patch\n") &&
    /^\*\*\* (Add File|Update File|Delete File): /mu.test(normalized)
  ) {
    normalized = `${normalized}\n*** End Patch`;
  }
  return normalizeAddFileLines(normalized);
}

function looksLikeGitUnifiedDiff(patch: string): boolean {
  return (
    /^diff --git /mu.test(patch) ||
    (/^--- [ab]\//mu.test(patch) && /^\+\+\+ [ab]\//mu.test(patch))
  );
}

function extractPatchPaths(patch: string): string[] | { error: string } {
  const lines = patch.replace(/\r\n?/gu, "\n").split("\n");
  if (looksLikeGitUnifiedDiff(patch)) {
    return {
      error:
        "apply_patch expects the AgenC patch grammar, not a git unified diff. Retry with *** Begin Patch, *** Add File/Update File/Delete File headers, and *** End Patch.",
    };
  }
  if (lines[0] !== "*** Begin Patch") {
    return { error: "patch must start with *** Begin Patch" };
  }
  if (!lines.includes("*** End Patch")) {
    return { error: "patch must end with *** End Patch" };
  }

  const paths: string[] = [];
  for (const line of lines) {
    const match = PATCH_PATH_HEADER.exec(line);
    if (!match) continue;
    const target = match[2]?.trim();
    if (!target) {
      return { error: `empty patch path in header: ${line}` };
    }
    paths.push(target);
  }

  if (paths.length === 0) {
    return { error: "patch does not contain any file operations" };
  }
  return paths;
}

function resolvePatchTarget(cwd: string, target: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function parseUpdateChunk(
  lines: readonly string[],
  lineNumber: number,
  allowMissingContext: boolean,
): ParsedChunk {
  if (lines.length === 0) {
    throw new Error(
      `Invalid patch hunk on line ${lineNumber}: Update hunk does not contain any lines`,
    );
  }

  let changeContext: string | undefined;
  let startIndex = 0;
  if (lines[0] === "@@") {
    startIndex = 1;
  } else if (lines[0]?.startsWith("@@ ")) {
    changeContext = lines[0].slice(3);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new Error(
      `Invalid patch hunk on line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
    );
  }

  if (startIndex >= lines.length) {
    throw new Error(
      `Invalid patch hunk on line ${lineNumber + 1}: Update hunk does not contain any lines`,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let parsedLines = 0;
  let isEndOfFile = false;

  for (const line of lines.slice(startIndex)) {
    if (line === "*** End of File") {
      if (parsedLines === 0) {
        throw new Error(
          `Invalid patch hunk on line ${lineNumber + 1}: Update hunk does not contain any lines`,
        );
      }
      isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const prefix = line[0];
    if (prefix === undefined) {
      oldLines.push("");
      newLines.push("");
      parsedLines += 1;
      continue;
    }
    if (prefix === " ") {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (prefix === "+") {
      newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (prefix === "-") {
      oldLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }

    if (parsedLines === 0) {
      throw new Error(
        `Invalid patch hunk on line ${lineNumber + 1}: Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }
    break;
  }

  return {
    chunk: {
      ...(changeContext !== undefined ? { changeContext } : {}),
      oldLines,
      newLines,
      isEndOfFile,
    },
    parsedLines: parsedLines + startIndex,
  };
}

function parseOneOperation(
  lines: readonly string[],
  lineNumber: number,
): ParsedOperation {
  const firstLine = lines[0]?.trim() ?? "";
  if (firstLine.startsWith("*** Add File: ")) {
    const path = firstLine.slice("*** Add File: ".length);
    let content = "";
    let parsedLines = 1;
    for (const line of lines.slice(1)) {
      if (!line.startsWith("+")) break;
      content += `${line.slice(1)}\n`;
      parsedLines += 1;
    }
    return {
      operation: { kind: "add", path, content },
      parsedLines,
    };
  }

  if (firstLine.startsWith("*** Delete File: ")) {
    return {
      operation: {
        kind: "delete",
        path: firstLine.slice("*** Delete File: ".length),
      },
      parsedLines: 1,
    };
  }

  if (firstLine.startsWith("*** Update File: ")) {
    const path = firstLine.slice("*** Update File: ".length);
    let remainingLines = lines.slice(1);
    let parsedLines = 1;
    let movePath: string | undefined;
    const maybeMove = remainingLines[0]?.trim();
    if (maybeMove?.startsWith("*** Move to: ")) {
      movePath = maybeMove.slice("*** Move to: ".length);
      remainingLines = remainingLines.slice(1);
      parsedLines += 1;
    }

    const chunks: UpdateChunk[] = [];
    while (remainingLines.length > 0) {
      if ((remainingLines[0] ?? "").trim().length === 0) {
        remainingLines = remainingLines.slice(1);
        parsedLines += 1;
        continue;
      }
      if ((remainingLines[0] ?? "").startsWith("*")) break;

      const parsed = parseUpdateChunk(
        remainingLines,
        lineNumber + parsedLines,
        chunks.length === 0,
      );
      chunks.push(parsed.chunk);
      remainingLines = remainingLines.slice(parsed.parsedLines);
      parsedLines += parsed.parsedLines;
    }

    if (chunks.length === 0) {
      throw new Error(
        `Invalid patch hunk on line ${lineNumber}: Update file hunk for path '${path}' is empty`,
      );
    }

    return {
      operation: {
        kind: "update",
        path,
        ...(movePath !== undefined ? { movePath } : {}),
        chunks,
      },
      parsedLines,
    };
  }

  throw new Error(
    `Invalid patch hunk on line ${lineNumber}: '${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

function parsePatchOperations(patch: string): PatchOperation[] {
  const lines = patch.trim().replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new Error("Invalid patch: The first line of the patch must be '*** Begin Patch'");
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") {
    throw new Error("Invalid patch: The last line of the patch must be '*** End Patch'");
  }

  const operations: PatchOperation[] = [];
  let remainingLines = lines.slice(1, -1);
  let lineNumber = 2;
  while (remainingLines.length > 0) {
    const parsed = parseOneOperation(remainingLines, lineNumber);
    operations.push(parsed.operation);
    remainingLines = remainingLines.slice(parsed.parsedLines);
    lineNumber += parsed.parsedLines;
  }

  if (operations.length === 0) {
    throw new Error("No files were modified.");
  }
  return operations;
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  endOfFile: boolean,
): number | null {
  if (pattern.length === 0) return startIndex;
  for (let i = startIndex; i <= lines.length - pattern.length; i += 1) {
    if (endOfFile && i + pattern.length !== lines.length) continue;
    let matched = true;
    for (let j = 0; j < pattern.length; j += 1) {
      if (lines[i + j] !== pattern[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return null;
}

function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateChunk[],
): Array<readonly [number, number, readonly string[]]> {
  const replacements: Array<readonly [number, number, readonly string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (contextIndex === null) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, [...chunk.newLines]]);
      continue;
    }

    let pattern = [...chunk.oldLines];
    let newLines = [...chunk.newLines];
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
    );
    if (found === null && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") {
        newLines = newLines.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new Error(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push([found, pattern.length, newLines]);
    lineIndex = found + pattern.length;
  }

  return replacements.sort(([lhs], [rhs]) => lhs - rhs);
}

function applyReplacements(
  originalLines: readonly string[],
  replacements: readonly (readonly [number, number, readonly string[]])[],
): string[] {
  const lines = [...originalLines];
  for (const [startIndex, oldLength, newSegment] of [...replacements].reverse()) {
    lines.splice(startIndex, oldLength, ...newSegment);
  }
  return lines;
}

async function deriveUpdatedContent(
  absolutePath: string,
  chunks: readonly UpdateChunk[],
): Promise<string> {
  const originalContent = await readFile(absolutePath, "utf8").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read file to update ${absolutePath}: ${message}`);
  });
  const originalLines = originalContent.split("\n");
  if (originalLines.at(-1) === "") originalLines.pop();

  const replacements = computeReplacements(originalLines, absolutePath, chunks);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0) return "";
  if (newLines.at(-1) !== "") newLines.push("");
  return newLines.join("\n");
}

async function writeFileCreatingParents(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function formatSummary(affected: AffectedPaths): string {
  const lines = ["Success. Updated the following files:"];
  for (const path of affected.added) lines.push(`A ${path}`);
  for (const path of affected.modified) lines.push(`M ${path}`);
  for (const path of affected.deleted) lines.push(`D ${path}`);
  return `${lines.join("\n")}\n`;
}

async function applyPatchInProcess(opts: {
  readonly patch: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ApplyPatchRunnerResult> {
  void opts.timeoutMs;
  if (opts.signal?.aborted) {
    return { stdout: "", stderr: "apply_patch aborted\n", exitCode: 1 };
  }
  try {
    const operations = parsePatchOperations(opts.patch);
    const affected: AffectedPaths = { added: [], modified: [], deleted: [] };
    for (const operation of operations) {
      if (opts.signal?.aborted) {
        return { stdout: "", stderr: "apply_patch aborted\n", exitCode: 1 };
      }
      const absolutePath = resolvePatchTarget(opts.cwd, operation.path);
      if (operation.kind === "add") {
        await writeFileCreatingParents(absolutePath, operation.content);
        affected.added.push(operation.path);
        continue;
      }
      if (operation.kind === "delete") {
        const metadata = await stat(absolutePath).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to delete file ${absolutePath}: ${message}`);
        });
        if (metadata.isDirectory()) {
          throw new Error(`Failed to delete file ${absolutePath}: path is a directory`);
        }
        await unlink(absolutePath).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to delete file ${absolutePath}: ${message}`);
        });
        affected.deleted.push(operation.path);
        continue;
      }

      const newContent = await deriveUpdatedContent(absolutePath, operation.chunks);
      if (operation.movePath !== undefined) {
        const destPath = resolvePatchTarget(opts.cwd, operation.movePath);
        await writeFileCreatingParents(destPath, newContent);
        const metadata = await stat(absolutePath).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to remove original ${absolutePath}: ${message}`);
        });
        if (metadata.isDirectory()) {
          throw new Error(`Failed to remove original ${absolutePath}: path is a directory`);
        }
        await unlink(absolutePath).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to remove original ${absolutePath}: ${message}`);
        });
        affected.modified.push(operation.movePath);
      } else {
        await writeFile(absolutePath, newContent, "utf8").catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to write file ${absolutePath}: ${message}`);
        });
        affected.modified.push(operation.path);
      }
    }
    return { stdout: formatSummary(affected), stderr: "", exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
  }
}

async function validatePatchPaths(opts: {
  readonly cwd: string;
  readonly patch: string;
  readonly allowedPaths: readonly string[];
  readonly args: Record<string, unknown>;
}): Promise<string | null> {
  const targets = extractPatchPaths(opts.patch);
  if ("error" in targets) return targets.error;

  const allowedPaths = resolveToolAllowedPaths(opts.allowedPaths, opts.args);
  const cwdSafe = await safePath(opts.cwd, allowedPaths);
  if (!cwdSafe.safe) {
    return `cwd is outside allowed directories: ${cwdSafe.reason}`;
  }
  const cwdStat = await stat(cwdSafe.resolved).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    return `cwd is not a directory: ${cwdSafe.resolved}`;
  }

  for (const target of targets) {
    if (isAbsolute(target)) {
      return `patch paths must be relative, never absolute: ${target}`;
    }
    const resolvedTarget = resolvePatchTarget(cwdSafe.resolved, target);
    const safe = await safePath(resolvedTarget, allowedPaths);
    if (!safe.safe) {
      return `patch target is outside allowed directories: ${target} (${safe.reason})`;
    }
  }
  return null;
}

export function createApplyPatchTool(config: ApplyPatchToolConfig): Tool {
  const runner = config.runner ?? applyPatchInProcess;
  return {
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["patch", "edit", "diff", "agenc"],
      preferredProfiles: ["coding"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "Complete AgenC patch body, starting with *** Begin Patch and ending with *** End Patch.",
        },
        input: {
          type: "string",
          description:
            "Alternate JSON key for the complete apply_patch body. Same value as patch.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for relative patch paths. Defaults to the workspace root.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
      },
      anyOf: [{ required: ["patch"] }, { required: ["input"] }],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as Record<string, unknown> & ToolExecutionInjectedArgs;
      const rawPatch = asNonEmptyString(args.patch) ?? asNonEmptyString(args.input);
      if (!rawPatch) return errorResult("patch must be a non-empty string");
      const patch = normalizePatchEnvelope(rawPatch);

      const cwdArg = asNonEmptyString(args.cwd);
      const cwd = cwdArg ?? config.allowedPaths[0] ?? process.cwd();
      const validationError = await validatePatchPaths({
        cwd,
        patch,
        allowedPaths: config.allowedPaths,
        args,
      });
      if (validationError) return errorResult(validationError);

      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? Math.max(1, Math.floor(args.timeoutMs))
          : DEFAULT_TIMEOUT_MS;

      const result = await runner({
        patch,
        cwd: resolve(cwd),
        timeoutMs,
        signal: args.__abortSignal,
      });
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter((entry) => entry.length > 0)
        .join("\n");
      if (result.exitCode !== 0) {
        return {
          content:
            output.length > 0
              ? output
              : `apply_patch failed with exit code ${result.exitCode}`,
          isError: true,
        };
      }
      return textResult(output);
    },
  };
}
