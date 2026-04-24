import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  resolveToolAllowedPaths,
  safePath,
} from "./filesystem.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
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
        "apply_patch expects the AgenC/Codex patch grammar, not a git unified diff. Retry with *** Begin Patch, *** Add File/Update File/Delete File headers, and *** End Patch.",
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

function runApplyPatchCommand(opts: {
  readonly patch: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ApplyPatchRunnerResult> {
  return new Promise((resolveResult) => {
    const child = execFile(
      "apply_patch",
      [opts.patch],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env: process.env,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (error, stdout, stderr) => {
        const typed = error as
          | (NodeJS.ErrnoException & { code?: number | string })
          | null;
        const errorCode =
          typeof typed?.code === "string" ? typed.code : undefined;
        const numericCode =
          typeof typed?.code === "number" ? typed.code : child.exitCode;
        resolveResult({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? numericCode ?? 1 : 0,
          ...(errorCode ? { errorCode } : {}),
        });
      },
    );
  });
}

export function createApplyPatchTool(config: ApplyPatchToolConfig): Tool {
  const runner = config.runner ?? runApplyPatchCommand;
  return {
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["patch", "edit", "diff", "codex", "agenc"],
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
            "Complete AgenC/Codex patch body, starting with *** Begin Patch and ending with *** End Patch.",
        },
        input: {
          type: "string",
          description:
            "Upstream Codex JSON key for the complete apply_patch body. Same value as patch.",
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
      const patch = asNonEmptyString(args.patch) ?? asNonEmptyString(args.input);
      if (!patch) return errorResult("patch must be a non-empty string");

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
      if (result.errorCode === "ENOENT") {
        return errorResult(
          "apply_patch executable was not found on PATH; install or expose the Codex apply_patch command.",
        );
      }
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
