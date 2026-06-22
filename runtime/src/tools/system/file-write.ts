/**
 * `Write` — port of the donor UI snapshot's file-write tool.
 *
 * Ports `src/tools/FileWriteTool/FileWriteTool.ts` and
 * `src/tools/FileWriteTool/prompt.ts` from donor UI snapshot commit
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8` onto AgenC's tool
 * contract. The model-facing description keeps the source behavior,
 * lightly adapted to AgenC's voice.
 *
 * Behavior preserved from upstream:
 *   - Creates a new file or overwrites an existing one.
 *   - Read-before-overwrite: existing files require a prior full
 *     `FileRead` (or equivalent session read) in the same
 *     session before the write is accepted. This is the same
 *     structural defense `Edit` and `Write` use against
 *     blind edits.
 *   - Modification-since-read: if the file was read previously but
 *     has changed on disk since that read (content-level compare,
 *     matching AgenC's existing snapshot semantics), the write is
 *     rejected with the exact upstream Edit-tool wording.
 *   - Auto-creates missing parent directories (mkdir -p).
 *   - UTF-8 default; CRLF in the existing on-disk file is normalized
 *     to LF when comparing against the prior session snapshot, and
 *     output is written with LF line endings (the model sent explicit
 *     line endings in `content` and meant them — we do not rewrite
 *     them).
 *   - `.ipynb` is rejected with a redirect to the notebook tool.
 *   - Path safety enforced via AgenC's `safePath` and
 *     `resolveToolAllowedPaths`.
 *   - Errors are returned as plain text (runtime envelope), not JSON.
 *
 * Source couplings intentionally not carried:
 *   - analytics / growthbook / `logEvent` calls
 *   - VS Code MCP file-update notifications
 *   - `lazySchema` / Zod (AgenC tools use plain JSON Schema POJOs)
 *   - Skill-discovery side effects from the written path
 *   - `fileHistoryTrackEdit` (AgenC's session-read snapshot already
 *     captures the post-write content)
 *
 * @module
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  Tool,
  ToolExecutionInjectedArgs,
  ToolResult,
} from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";
import { buildFileMutationMetadata } from "../result-metadata.js";
import {
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
  safePathAllowingSessionPlanFile,
  SESSION_ID_ARG,
  type SessionReadViewKind,
} from "./filesystem.js";
import {
  agentNamespacePathHint,
  denyAgentNamespacePath,
  isAgentNamespacePath,
} from "./agent-path-hints.js";
import { checkToolPathPermission } from "../../permissions/path-validation.js";
import { notifyLspFileChanged } from "../../services/lsp/fileNotifications.js";

export const FILE_WRITE_TOOL_NAME = "Write";

/**
 * Verbatim wording from the upstream file-write prompt,
 * lightly adapted: the upstream "Edit tool" reference is kept (AgenC
 * exposes `Edit` for incremental edits), and the
 * pre-read instruction is generalized away from the exact
 * `FILE_READ_TOOL_NAME` constant since AgenC doesn't pin a single
 * read-tool name in this description.
 */
const FILE_WRITE_DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- Use workspace-relative paths like 'game.py' unless the user provided a real absolute path. Do not use '/root/...'; '/root' is the agent namespace, not the filesystem.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

/**
 * Verbatim from the upstream file-write tool. Used when the
 * target file exists but the model has not read it in this session.
 */
const READ_REQUIRED_MESSAGE =
  "File has not been read yet. Read it first before writing to it.";

/**
 * Verbatim from the upstream file-edit constants. Used when the target was read
 * previously but the on-disk content has drifted since that read.
 */
const FILE_UNEXPECTEDLY_MODIFIED_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

const NOTEBOOK_REDIRECT_MESSAGE =
  "Use NotebookEdit for `.ipynb` notebooks instead of Write.";

/**
 * Returned when an existing file is overwritten without a session id.
 * Mirrors `Edit`/`MultiEdit` (file-edit.ts): the runtime injects the
 * session id automatically, so its absence on an existing-file write
 * means a production code path lost it. Failing loud here surfaces that
 * class of bug instead of silently overwriting with no read-before-write
 * or modification-drift check.
 */
const SESSION_ID_MISSING_ERROR =
  "Write was invoked without a session id for an existing file. The runtime injects this automatically; if you are calling the tool from a unit test, pass __testBypassSessionGuard:true to opt out of read-before-write enforcement.";

/**
 * Test-only opt-out of the read-before-write session guard. Production
 * callers must NEVER set this — the canonical tool surface injects
 * SESSION_ID_ARG automatically. Tests that exercise the tool at the
 * execute boundary without a full session lifecycle can pass
 * `__testBypassSessionGuard:true`.
 *
 * Defense in depth: the flag is ONLY honored when NODE_ENV === "test",
 * so a model that smuggles the arg key into a production dispatch cannot
 * disable the gate — same convention as `Edit`'s guard.
 */
const TEST_BYPASS_SESSION_GUARD_ARG = "__testBypassSessionGuard";

function shouldBypassSessionGuard(args: Record<string, unknown>): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  return args[TEST_BYPASS_SESSION_GUARD_ARG] === true;
}

export interface FileWriteToolConfig {
  /**
   * Allowed path prefixes — all writes must canonicalize inside one
   * of these. When omitted, falls back to `process.cwd()` so the tool
   * is still safely usable in headless / direct-invocation contexts.
   */
  readonly allowedPaths?: readonly string[];
  /** Optional cap on the number of bytes the tool will write. */
  readonly maxWriteBytes?: number;
}

interface FileWriteToolInput extends ToolExecutionInjectedArgs {
  readonly file_path?: unknown;
  readonly content?: unknown;
  readonly cwd?: unknown;
  readonly [SESSION_ID_ARG]?: unknown;
}

const DEFAULT_MAX_WRITE_BYTES = 10_485_760; // 10 MB — matches filesystem.ts

function successResult(message: string): ToolResult {
  return { content: message };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * CRLF → LF normalize. Used for both the existing on-disk content
 * (compared against the session snapshot) and never applied to the
 * outgoing `content` — the model's explicit line endings win on write.
 */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

/**
 * Mirror AgenC's `readFreshTextSnapshot` shape so the value we
 * write to the session-read state matches the rest of the AgenC
 * filesystem tooling.
 */
function buildSnapshot(
  content: string,
  mtimeMs: number,
): {
  readonly content: string;
  readonly rawContent: string;
  readonly timestamp: number;
  readonly viewKind: SessionReadViewKind;
} {
  return {
    content,
    // Post-write content IS the raw bytes on disk; populating rawContent
    // here keeps the changed-files producer from firing a spurious diff
    // on the next turn for the file we just wrote.
    rawContent: content,
    timestamp: Number.isFinite(mtimeMs) ? mtimeMs : Date.now(),
    viewKind: "full",
  };
}

export function createFileWriteTool(
  config: FileWriteToolConfig = {},
): Tool {
  const allowedPaths = config.allowedPaths ?? [process.cwd()];
  const maxWriteBytes = config.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;

  return {
    name: FILE_WRITE_TOOL_NAME,
    description: FILE_WRITE_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["write", "file", "create", "overwrite"],
      preferredProfiles: ["coding", "general"],
      hiddenByDefault: false,
      mutating: true,
      deferred: false,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Workspace-relative path, or a real absolute filesystem path. Do not use /root; that is the agent namespace.",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
    checkPermissions(input, context) {
      const args = input as FileWriteToolInput;
      const filePath = asNonEmptyString(args.file_path);
      if (!filePath) {
        return {
          behavior: "ask",
          message: "file_path must be a non-empty string",
        };
      }
      const cwd = asNonEmptyString(args.cwd) ?? allowedPaths[0] ?? process.cwd();
      if (isAgentNamespacePath(filePath)) {
        return denyAgentNamespacePath(filePath, cwd);
      }
      return checkToolPathPermission({
        toolName: FILE_WRITE_TOOL_NAME,
        input: input as Record<string, unknown>,
        path: filePath,
        cwd,
        context: context.getAppState().toolPermissionContext,
        operationType: "write",
        extraWorkingDirectories: allowedPaths,
      });
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as FileWriteToolInput;

      const filePath = asNonEmptyString(args.file_path);
      if (!filePath) {
        return errorResult("file_path must be a non-empty string");
      }
      const content = asString(args.content);
      if (content === undefined) {
        return errorResult("content must be a string");
      }

      const cwdArg = asNonEmptyString(args.cwd);
      const cwd = cwdArg ?? allowedPaths[0] ?? process.cwd();
      if (isAgentNamespacePath(filePath)) {
        return errorResult(agentNamespacePathHint(filePath, cwd));
      }

      // Notebook redirect — AgenC routes `.ipynb` to NotebookEdit
      // instead of allowing a raw text write that would corrupt the
      // notebook's JSON envelope.
      if (filePath.toLowerCase().endsWith(".ipynb")) {
        return errorResult(NOTEBOOK_REDIRECT_MESSAGE);
      }

      const absoluteInput = resolve(cwd, filePath);

      const safe = await safePathAllowingSessionPlanFile(
        absoluteInput,
        allowedPaths,
        rawArgs,
      );
      if (!safe.safe) {
        return errorResult(
          `file_path is outside allowed directories: ${filePath}` +
            (safe.reason ? ` (${safe.reason})` : ""),
        );
      }
      const absolutePath = safe.resolved;

      const sessionId =
        typeof args[SESSION_ID_ARG] === "string" &&
        (args[SESSION_ID_ARG] as string).trim().length > 0
          ? (args[SESSION_ID_ARG] as string)
          : undefined;

      // Stat the target. ENOENT means we are creating a brand-new
      // file; any other failure is surfaced as a write error.
      let existed = false;
      let existingStat: { mtimeMs: number } | null = null;
      let existingContentForUi = "";
      try {
        const result = await stat(absolutePath);
        if (result.isDirectory()) {
          return errorResult(
            `file_path resolves to a directory: ${filePath}`,
          );
        }
        existed = true;
        existingStat = { mtimeMs: result.mtimeMs };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          return errorResult(
            code ? `${code}: stat failed for ${filePath}` : `stat failed for ${filePath}`,
          );
        }
      }

      // Read-before-overwrite enforcement. Verbatim upstream wording
      // when the existing file was not read in this session. Headless
      // invocations (no `__agencSessionId`) bypass the gate so unit
      // tests and embedded contexts keep working — same convention as
      // `Edit`'s gate.
      if (existed && sessionId !== undefined) {
        if (!hasSessionRead(sessionId, absolutePath)) {
          return errorResult(READ_REQUIRED_MESSAGE);
        }

        // Modification-since-read drift check. A FULL read carries the
        // captured content, so we compare current on-disk content
        // (CRLF-normalized) against the snapshot for parity with
        // `Edit`. A PARTIAL offset/limit read authorized the overwrite
        // above (read-before-write only forces the model to see real
        // bytes) but cannot prove the whole file is unchanged, so we
        // fall back to an mtime-drift check that mirrors `Edit`'s gate.
        const snapshot = getSessionReadSnapshot(sessionId, absolutePath);
        const snapshotContent =
          typeof snapshot?.rawContent === "string"
            ? snapshot.rawContent
            : snapshot?.content;
        const isFullSnapshot =
          snapshot?.viewKind === "full" &&
          snapshot.isPartialView !== true &&
          typeof snapshotContent === "string";

        if (isFullSnapshot) {
          let onDisk: string;
          try {
            const buffer = await readFile(absolutePath);
            onDisk = normalizeNewlines(buffer.toString("utf-8"));
            existingContentForUi = onDisk;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            return errorResult(
              code
                ? `${code}: failed to re-read ${filePath} before overwrite`
                : `failed to re-read ${filePath} before overwrite`,
            );
          }
          if (onDisk !== normalizeNewlines(snapshotContent as string)) {
            return errorResult(FILE_UNEXPECTEDLY_MODIFIED_MESSAGE);
          }
        } else {
          // Partial-read fallback: reject only when the on-disk mtime
          // advanced past the recorded read timestamp (an external
          // mutation), so the model is forced to re-read stale state.
          const recordedTs = snapshot?.timestamp;
          if (
            existingStat !== null &&
            typeof recordedTs === "number" &&
            Number.isFinite(recordedTs) &&
            existingStat.mtimeMs > recordedTs
          ) {
            return errorResult(FILE_UNEXPECTEDLY_MODIFIED_MESSAGE);
          }
          // Populate the UI snapshot from disk best-effort.
          try {
            const buffer = await readFile(absolutePath);
            existingContentForUi = normalizeNewlines(buffer.toString("utf-8"));
          } catch {
            existingContentForUi = "";
          }
        }
      } else if (existed) {
        // Existing file but no session id. The read-before-write and
        // modification-drift checks above all hang off the session id,
        // so without it there is no gate at all. Fail loud — exactly as
        // `Edit`/`MultiEdit` do (file-edit.ts) — instead of silently
        // overwriting and clobbering concurrent external modifications.
        // Tests opt out explicitly via __testBypassSessionGuard:true.
        if (!shouldBypassSessionGuard(rawArgs)) {
          return errorResult(SESSION_ID_MISSING_ERROR);
        }
        if (existingStat !== null) {
          try {
            const buffer = await readFile(absolutePath);
            existingContentForUi = normalizeNewlines(buffer.toString("utf-8"));
          } catch {
            existingContentForUi = "";
          }
        }
      }

      const data = Buffer.from(content, "utf-8");
      if (data.length > maxWriteBytes) {
        return errorResult(
          `Content size ${data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
        );
      }

      // Auto-create parent directories. Equivalent to the AgenC
      // `mkdir -p` step at FileWriteTool.ts:254 — done before the
      // write so a missing-directory ENOENT surfaces here cleanly.
      try {
        await mkdir(dirname(absolutePath), { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        return errorResult(
          code
            ? `${code}: failed to create parent directory for ${filePath}`
            : `failed to create parent directory for ${filePath}`,
        );
      }

      try {
        await writeFile(absolutePath, data);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        return errorResult(
          code
            ? `${code}: failed to write ${filePath}`
          : `failed to write ${filePath}`,
        );
      }

      notifyLspFileChanged(absolutePath, content);

      // Record the post-write content as the session's view of the
      // file so subsequent overwrites/edits in the same session do
      // not need an extra explicit read. Matches the canonical write
      // path's post-write `recordSessionRead`.
      if (sessionId !== undefined) {
        let mtimeMs: number = Date.now();
        try {
          const post = await stat(absolutePath);
          if (Number.isFinite(post.mtimeMs)) {
            mtimeMs = post.mtimeMs;
          }
        } catch {
          // Best-effort — fall back to wall clock on the snapshot.
        }
        recordSessionRead(
          sessionId,
          absolutePath,
          buildSnapshot(content, mtimeMs),
        );
      }

      // Plain-text result — runtime envelope. Matches AgenC's
      // `mapToolResultToToolResultBlockParam` (FileWriteTool.ts:421-435).
      void existingStat;
      return {
        ...successResult(
          existed
            ? `The file ${filePath} has been updated successfully.`
            : `File created successfully at: ${filePath}`,
        ),
        metadata: buildFileMutationMetadata({
          filePath,
          operation: existed ? "write" : "create",
          beforeText: existed ? existingContentForUi : "",
          afterText: content,
        }),
      };
    },
  };
}
