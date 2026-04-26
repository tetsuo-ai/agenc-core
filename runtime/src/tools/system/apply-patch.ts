import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import {
  hasSessionRead,
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

Then one or more hunks, each introduced by @@. Within a hunk, EVERY line MUST start with one of these three single-character prefixes:
  - a single space (\` \`) for an unchanged context line
  - a minus (\`-\`) for a line being removed
  - a plus (\`+\`) for a line being added

A context line that already starts with \`#\`, \`/\`, \`*\`, \`-\`, \`+\`, or any other character STILL needs the leading space — the prefix is what tells the parser it's a hunk line, not a header. Example showing why this matters:

  WRONG (omits space prefix on context lines):
    @@
    #ifndef FOO_H
    -#define FOO_H 1
    +#define FOO_H 2
    #endif

  RIGHT (every hunk line has a single-char prefix):
    @@
     #ifndef FOO_H
    -#define FOO_H 1
    +#define FOO_H 2
     #endif

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

Context lines (prefixed with a space) are how the tool finds where to apply each hunk.
- By default, include up to 3 lines of unchanged code immediately above and below each change.
- If 3 lines is not enough to uniquely identify the snippet inside the file, expand the @@ header to name the enclosing class or function (e.g. @@ class Foo: or @@ def bar():). Multiple @@ headers in a row narrow the scope progressively.
- For trailing edits, include "*** End of File" as the last line of the hunk so the tool biases toward the end of the file when locating the match.
- Match is byte-for-byte first; whitespace, dash/quote/NBSP variants are forgiven as fallbacks. Prefer copying the existing lines verbatim — invented context drifts.

Important:
- Include an Add/Delete/Update header for every file operation.
- Prefix new lines with +, including every line when creating a file.
- File references must be relative, never absolute.
- Put the complete patch body in the patch argument.
- For \`*** Update File:\`, you MUST have called \`system.readFile\` on the target path (without offset/limit) earlier in the session. The tool will reject the patch with an actionable error if you have not. After a seek-failure error, re-read the file before retrying — invented context lines drift from the live file content.`;

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

/**
 * Codex parity: errors flow through `FunctionCallError::RespondToModel(String)`
 * which serializes as a plain-text `InputText` content item in the
 * `FunctionCallOutputPayload` (see codex
 * `core/src/tools/handlers/apply_patch.rs:448-462` and `core/src/tools/context.rs:255`).
 * No JSON envelope. The model reads the error string directly.
 *
 * Parse-time errors carry codex's `"apply_patch verification failed: "`
 * prefix (handlers/apply_patch.rs:448-450) inside the error string itself,
 * baked in by `extractPatchPaths`. Path-safety / read-before-write errors
 * have no codex parallel and stay un-prefixed.
 */
function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
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

function isPatchBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("*** Add File: ") ||
    trimmed.startsWith("*** Delete File: ") ||
    trimmed.startsWith("*** Update File: ") ||
    trimmed === "*** End Patch"
  );
}

function isPlusPrefixedPatchBoundary(line: string): boolean {
  return isPatchBoundaryLine(line.startsWith("+") ? line.slice(1) : line);
}

function hasEndPatchLine(patch: string): boolean {
  return patch.split("\n").some((line) => line.trim() === "*** End Patch");
}

function repairPlusPrefixedPatchRemainder(patch: string): string {
  const lines = patch.split("\n");
  if (!lines.some((line) => line.startsWith("+") && isPlusPrefixedPatchBoundary(line))) {
    return patch;
  }

  const repaired: string[] = [];
  let repairRemainder = false;
  for (const line of lines) {
    if (!repairRemainder && line.startsWith("+") && isPlusPrefixedPatchBoundary(line)) {
      repairRemainder = true;
    }
    repaired.push(repairRemainder && line.startsWith("+") ? line.slice(1) : line);
  }
  return repaired.join("\n");
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

function unwrapHeredocWrapper(patch: string): string {
  const trimmed = patch.trim();
  const lines = trimmed.split("\n");
  if (lines.length < 4) return patch;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const isHeredocOpener =
    first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
  if (!isHeredocOpener || !last?.endsWith("EOF")) return patch;
  return lines.slice(1, -1).join("\n");
}

function normalizePatchEnvelope(patch: string): string {
  let normalized = patch.replace(/\r\n?/gu, "\n").trimEnd();
  normalized = unwrapHeredocWrapper(normalized);
  normalized = repairPlusPrefixedPatchRemainder(normalized);
  normalized = normalized.replace(/^\s*(?=\*\*\* Begin Patch(?:\n|$))/u, "");
  if (
    !hasEndPatchLine(normalized) &&
    normalized.startsWith("*** Begin Patch") &&
    /^\*\*\* (Add File|Update File|Delete File): /mu.test(normalized)
  ) {
    normalized = `${normalized}\n*** End Patch`;
  }
  return normalizeAddFileLines(normalized);
}

/**
 * Verbatim port of codex `apply-patch/src/parser.rs:validate_patch_markers`
 * (lines 280-296). Both first and last non-empty lines are `.trim()`-compared
 * to the marker strings, which is what tolerates Grok-style ` *** End Patch`
 * (leading whitespace from a hunk-context misread). AgenC's previous
 * `lines.includes("*** End Patch")` strict check was the AgenC-side drift
 * that caused the 12-retry loop in session conv-mof0lxho.
 *
 * Drops the AgenC-invented `looksLikeGitUnifiedDiff` early-return and the
 * "empty patch path in header" check — codex's parser does not have either.
 * Empty patches surface from the runner as codex's `"No files were modified."`
 * (lib.rs:267).
 */
function extractPatchPaths(patch: string): string[] | { error: string } {
  const lines = patch.replace(/\r\n?/gu, "\n").split("\n");
  const firstLine = (lines[0] ?? "").trim();
  // Mirror codex's `last_line` semantics: take the literal last line of the
  // input. `normalizePatchEnvelope` already `trimEnd`s the patch, so any
  // trailing newline is stripped before this point and the last element is
  // the actual terminator line.
  const lastLine = (lines[lines.length - 1] ?? "").trim();
  if (firstLine !== "*** Begin Patch") {
    // Verbatim from codex parser.rs:289-291; codex handler prefixes parse
    // errors with "apply_patch verification failed: " (handlers/apply_patch.rs:448).
    return {
      error:
        "apply_patch verification failed: The first line of the patch must be '*** Begin Patch'",
    };
  }
  if (lastLine !== "*** End Patch") {
    // Verbatim from codex parser.rs:292-294 + handler prefix.
    return {
      error:
        "apply_patch verification failed: The last line of the patch must be '*** End Patch'",
    };
  }

  const paths: string[] = [];
  for (const line of lines) {
    const match = PATCH_PATH_HEADER.exec(line);
    if (!match) continue;
    const target = match[2]?.trim();
    if (!target) continue;
    paths.push(target);
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

    // Patch envelope markers terminate the current hunk. Anything starting
    // with `*** ` is one of: End Patch, Add File, Delete File, Update File,
    // Move to. `@@` starts a new hunk. Both end the current hunk parse.
    if (line.startsWith("*** ") || line.startsWith("@@")) {
      break;
    }

    const prefix = line[0];
    if (prefix === undefined) {
      // Empty line — treat as a blank context line (matches the historical
      // behavior and the model's intuition that blank lines are context).
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

    // Lenient recovery: a line inside a hunk that doesn't start with one of
    // the canonical prefixes ' ', '+', '-' AND isn't a `*** ...` / `@@`
    // marker is the most common patch-authoring mistake — the model wrote
    // a context line and forgot the leading space. Codex/upstream strictly
    // rejects, but in practice that rejection just makes the model give up
    // and rewrite the whole file. Treat the line as context with an
    // implicit space prefix; the seek path's whitespace-tolerant fallbacks
    // will validate it against the file. If the content is genuinely
    // garbage, the seek will fail with the actionable error message
    // (file context + hints) and the model can correct on retry.
    oldLines.push(line);
    newLines.push(line);
    parsedLines += 1;
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

const UNICODE_DASH_RE = /[‐‑‒–—―−]/gu;
const UNICODE_SINGLE_QUOTE_RE = /[‘’‚‛]/gu;
const UNICODE_DOUBLE_QUOTE_RE = /[“”„‟]/gu;
const UNICODE_SPACE_RE =
  /[            　]/gu;

function normalizeForFuzzyMatch(value: string): string {
  return value
    .trim()
    .replace(UNICODE_DASH_RE, "-")
    .replace(UNICODE_SINGLE_QUOTE_RE, "'")
    .replace(UNICODE_DOUBLE_QUOTE_RE, '"')
    .replace(UNICODE_SPACE_RE, " ");
}

function trimEnd(value: string): string {
  return value.replace(/\s+$/u, "");
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  endOfFile: boolean,
): number | null {
  if (pattern.length === 0) return startIndex;
  if (pattern.length > lines.length) return null;

  const searchEnd = lines.length - pattern.length;
  const eofIndex = lines.length - pattern.length;

  const passes: ReadonlyArray<(value: string) => string> = [
    (value) => value,
    trimEnd,
    (value) => value.trim(),
    normalizeForFuzzyMatch,
  ];

  const matchAt = (
    i: number,
    project: (value: string) => string,
  ): boolean => {
    for (let j = 0; j < pattern.length; j += 1) {
      if (project(lines[i + j] ?? "") !== project(pattern[j] ?? "")) {
        return false;
      }
    }
    return true;
  };

  for (const project of passes) {
    // When the patch hunk has *** End of File, try the end-of-file
    // position first — codex/seek_sequence.rs:29-33 does the same. This
    // matters for trailing edits where the final block of the file is
    // ambiguously similar to earlier text; without the EOF bias we'd
    // match an earlier occurrence and write the new lines in the wrong
    // location, then the next hunk's seek fails.
    if (endOfFile && eofIndex >= startIndex) {
      if (matchAt(eofIndex, project)) return eofIndex;
    }
    for (let i = startIndex; i <= searchEnd; i += 1) {
      if (i === eofIndex && endOfFile) continue; // already tried above
      if (matchAt(i, project)) return i;
    }
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
        // Verbatim from codex `apply-patch/src/lib.rs:461-466`.
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        originalLines.at(-1) === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIndex, 0, [...chunk.newLines]]);
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
      // Verbatim from codex `apply-patch/src/lib.rs:518-522`.
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
  // Normalize the FILE's line endings before split so seekSequence can
  // match patches authored with LF against files written with CRLF. The
  // patch envelope was already CRLF→LF normalized in normalizePatchEnvelope;
  // without doing the same to the file, a CRLF file makes every fallback
  // pass fail (rstrip/trim/Unicode normalize the pattern but the file's
  // line still ends in \r). Detect the original ending so we can restore
  // it on write — Windows users expect their CRLF endings preserved.
  const usedCrlf = /\r\n/.test(originalContent);
  const normalizedContent = originalContent.replace(/\r\n?/gu, "\n");
  const originalLines = normalizedContent.split("\n");
  if (originalLines.at(-1) === "") originalLines.pop();

  const replacements = computeReplacements(originalLines, absolutePath, chunks);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0) return "";
  if (newLines.at(-1) !== "") newLines.push("");
  const joined = newLines.join("\n");
  return usedCrlf ? joined.replace(/\n/g, "\r\n") : joined;
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

/**
 * Read-before-write gate. For every `*** Update File:` operation in the
 * patch, verify the target file was read with `system.readFile` (full
 * view) in the current session. If not, reject the patch with the same
 * actionable error format the filesystem tools use. Mirrors openclaude
 * `FileEditTool` (FileEditTool.ts:276-286 + prompt.ts:4-8) where the
 * pre-read requirement is the structural defense against blind edits.
 *
 * Skipped when:
 *   - No `__agencSessionId` was injected (headless / unit-test path).
 *   - The operation is `*** Add File:` (creating new — no read needed).
 *   - The operation is `*** Delete File:` (no patch context to invent).
 *   - The target file does not exist on disk (treated as Add for read
 *     purposes — the patch will fail later with a clearer "file not
 *     found" error if Update is attempted on a non-existent path).
 */
async function enforceReadBeforePatch(opts: {
  readonly patch: string;
  readonly cwd: string;
  readonly sessionId: string | undefined;
}): Promise<string | null> {
  if (opts.sessionId === undefined) return null;
  let operations: PatchOperation[];
  try {
    operations = parsePatchOperations(opts.patch);
  } catch {
    // Parse will fail again in the runner with a more useful error;
    // don't pre-empt that path here.
    return null;
  }
  for (const op of operations) {
    if (op.kind !== "update") continue;
    const absolutePath = resolvePatchTarget(opts.cwd, op.path);
    const targetExists = await stat(absolutePath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!targetExists) continue;
    if (!hasSessionRead(opts.sessionId, absolutePath)) {
      return (
        `apply_patch: file must be fully read before patching it. ` +
        `Call system.readFile on "${op.path}" without offset/limit, ` +
        `then re-issue the apply_patch call with context lines that ` +
        `match the file you just read.`
      );
    }
  }
  return null;
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

      // Read-before-write enforcement (openclaude FileEditTool parity:
      // src/tools/FileEditTool/prompt.ts:4-8 + FileEditTool.ts:276-286).
      // The single highest-leverage defense against models inventing
      // context lines they never verified is the structural rule: a
      // patch against an existing file is rejected unless that file
      // was first read with `system.readFile` in the same session.
      // Forces the model to put the literal pre-edit bytes in its
      // context window before generating the next patch — which is
      // what self-correction needs.
      // Skipped for `*** Add File:` (creating a new file — no prior
      // read possible) and for `*** Delete File:` (no patch context
      // to invent). Only `*** Update File:` / `*** Move to:` paths
      // need the read.
      const readEnforcementError = await enforceReadBeforePatch({
        patch,
        cwd: resolve(cwd),
        sessionId: asNonEmptyString(args.__agencSessionId),
      });
      if (readEnforcementError) return errorResult(readEnforcementError);

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
