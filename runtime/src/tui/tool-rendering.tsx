import React from "react";

import { Box, Text } from "./ink.js";
import { AskUserQuestionTool } from "../tools/ask-user-question/tui-tool.js";
import {
  pickToolResultDispatch,
  resultTextForTuiTool,
} from "./tool-result-routing.js";

/**
 * Tag extractor mirroring upstream `extractTag` semantics — pulls
 * `<tag>...</tag>` content out of a flat string. Inlined locally
 * instead of imported from `agenc/upstream/utils/messages.ts` because
 * that module pulls a `bun:bundle` feature gate + provider chain in
 * at module-load time, which the vitest source resolver cannot follow.
 * The TUI renderer only needs the regex extraction; nothing else from that
 * file is in scope.
 */
function extractToolTag(content: string, tagName: string): string | null {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const startIdx = content.indexOf(open);
  if (startIdx === -1) return null;
  const valueStart = startIdx + open.length;
  const closeIdx = content.indexOf(close, valueStart);
  if (closeIdx === -1) return null;
  return content.slice(valueStart, closeIdx);
}

/**
 * Local Bash output renderer. Visually equivalent to upstream
 * `UserBashOutputMessage` (extracts `<bash-stdout>` and `<bash-stderr>`
 * tags and renders them in distinct colors), but does not import
 * upstream component because the upstream chain drags `bun:bundle`
 * resolution through a feature-gated `require('../memdir/teamMemPaths.js')`
 * inside `agenc/upstream/utils/config.ts` that vitest cannot follow
 * from raw source (only the compiled dist resolves it). Production
 * runtime CAN later be flipped to dispatch to the real upstream
 * component once the dist is in scope; the wire shape
 * (`<bash-stdout>` envelope produced by
 * `session-transcript.formatStructuredToolResult`) is already the
 * upstream-compatible one. Until then this local renderer is the
 * dispatch target for `pickToolResultDispatch === 'bash-output-view'`.
 */
const BASH_OUTPUT_TRUNCATION_LIMIT = 8 * 1024;
const GLOB_TRUNCATION_NOTE =
  "(Results are truncated. Consider using a more specific path or pattern.)";

function truncateForDisplay(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit - 64);
  const dropped = value.length - head.length;
  return `${head}\n… [${dropped} chars truncated]`;
}

/**
 * Local diff renderer for the `Edit` tool. Mirrors the visual
 * contract of upstream `FileEditToolDiff` / `StructuredDiffList` —
 * file-path header, hunk header (`@@ ... @@`) in cyan, additions in
 * green, deletions in red — but does not import upstream because
 * `FileEditToolDiff` requires a live `edits[]` array to call
 * `loadDiffData(file_path, edits)` (which reads the file from disk).
 * AgenC's tool result already contains the computed diff string, so
 * this local renderer parses the diff lines directly. Production
 * runtime can later flip to the upstream component once the TUI
 * propagates the original `edits[]` from the matching tool_use input
 * (`UserToolSuccessMessage` already passes `options.input` to
 * `renderToolResultMessage`).
 */
export function EditDiffView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const file = extractToolTag(content, "edit-file") ?? "";
  const diff = extractToolTag(content, "edit-diff") ?? "";
  if (diff.length === 0) {
    return (
      <Box flexDirection="column">
        {file.length > 0 ? <Text bold>{file}</Text> : null}
        <Text dimColor>(No changes)</Text>
      </Box>
    );
  }
  const truncatedDiff = truncateForDisplay(diff, BASH_OUTPUT_TRUNCATION_LIMIT);
  const lines = truncatedDiff.split("\n");
  return (
    <Box flexDirection="column">
      {file.length > 0 ? <Text bold>{file}</Text> : null}
      {lines.map((line, idx) => {
        let color: string | undefined;
        let dim: boolean | undefined;
        if (line.startsWith("+++") || line.startsWith("---")) {
          dim = true;
        } else if (line.startsWith("+")) {
          color = "green";
        } else if (line.startsWith("-")) {
          color = "red";
        } else if (line.startsWith("@@")) {
          color = "cyan";
        }
        return (
          <Text key={idx} color={color} dimColor={dim}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Local FileRead renderer. Bold path header, optional line range,
 * monospace content body. Mirrors upstream `FileReadTool/UI.tsx`
 * visual contract without importing it (same bun:bundle / config.ts
 * resolution issue as the Bash and Edit renderers).
 */
export function FileReadView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const file = extractToolTag(content, "read-file") ?? "";
  const lines = extractToolTag(content, "read-lines") ?? "";
  const body = extractToolTag(content, "read-content") ?? "";
  const truncatedBody = truncateForDisplay(body, BASH_OUTPUT_TRUNCATION_LIMIT);
  const headerText =
    lines.length > 0 ? `${file} [${lines}]` : file;
  return (
    <Box flexDirection="column">
      {file.length > 0 ? <Text bold>{headerText}</Text> : null}
      {truncatedBody.length > 0 ? (
        <Text>{truncatedBody}</Text>
      ) : (
        <Text dimColor>(empty file)</Text>
      )}
    </Box>
  );
}

/**
 * Local Write renderer. One-line "Wrote N bytes to <path>" summary.
 * Mirrors upstream `FileWriteTool/UI.tsx` visual contract.
 */
export function FileWriteView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const file = extractToolTag(content, "write-file") ?? "";
  const summary = extractToolTag(content, "write-summary") ?? "Wrote file";
  return (
    <Box flexDirection="column">
      {file.length > 0 ? <Text bold>{file}</Text> : null}
      <Text color="green">{summary}</Text>
    </Box>
  );
}

/**
 * Local Grep matches renderer. One line per match formatted as
 * `file:line:content`, with file path bolded via Text dimming on the
 * line metadata. Mirrors upstream `GrepTool/UI.tsx` visual contract.
 */
export function GrepMatchesView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const pattern = extractToolTag(content, "grep-pattern") ?? "";
  const matchesBlock = extractToolTag(content, "grep-matches") ?? "";
  const matchLines = matchesBlock.length > 0 ? matchesBlock.split("\n") : [];
  if (matchLines.length === 0) {
    const emptyHeader = pattern.length > 0 ? `Grep: ${pattern}` : null;
    return (
      <Box flexDirection="column">
        {emptyHeader !== null ? <Text bold>{emptyHeader}</Text> : null}
        <Text dimColor>(no matches)</Text>
      </Box>
    );
  }
  const TRUNCATE_AT = 200;
  const visible = matchLines.slice(0, TRUNCATE_AT);
  const truncatedCount = matchLines.length - visible.length;
  const headerText =
    pattern.length > 0
      ? `Grep: ${pattern} (${matchLines.length} ${
          matchLines.length === 1 ? "match" : "matches"
        })`
      : null;
  return (
    <Box flexDirection="column">
      {headerText !== null ? <Text bold>{headerText}</Text> : null}
      {visible.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
      {truncatedCount > 0 ? (
        <Text dimColor>{`… ${truncatedCount} more matches truncated`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * Local Glob path-list renderer. Mirrors upstream `GlobTool/UI.tsx`
 * visual contract — pattern header + one path per line.
 */
export function GlobPathsView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const pattern = extractToolTag(content, "glob-pattern") ?? "";
  const pathsBlock = extractToolTag(content, "glob-paths") ?? "";
  const truncated = extractToolTag(content, "glob-truncated") === "true";
  const paths = pathsBlock.length > 0 ? pathsBlock.split("\n") : [];
  if (paths.length === 0) {
    const emptyHeader = pattern.length > 0 ? `Glob: ${pattern}` : null;
    return (
      <Box flexDirection="column">
        {emptyHeader !== null ? <Text bold>{emptyHeader}</Text> : null}
        <Text dimColor>(no paths)</Text>
        {truncated ? <Text dimColor>{GLOB_TRUNCATION_NOTE}</Text> : null}
      </Box>
    );
  }
  const TRUNCATE_AT = 200;
  const visible = paths.slice(0, TRUNCATE_AT);
  const truncatedCount = paths.length - visible.length;
  const headerText =
    pattern.length > 0
      ? `Glob: ${pattern} (${paths.length} ${
          paths.length === 1 ? "path" : "paths"
        })`
      : null;
  return (
    <Box flexDirection="column">
      {headerText !== null ? <Text bold>{headerText}</Text> : null}
      {visible.map((path, idx) => (
        <Text key={idx}>{path}</Text>
      ))}
      {truncatedCount > 0 ? (
        <Text dimColor>{`… ${truncatedCount} more paths truncated`}</Text>
      ) : null}
      {truncated ? <Text dimColor>{GLOB_TRUNCATION_NOTE}</Text> : null}
    </Box>
  );
}

/**
 * Cross-cutting tool-error renderer. Mirrors upstream
 * `FallbackToolUseErrorMessage` — red-bold header + dimmed message.
 * Used for any tool whose result arrives via the error channel,
 * regardless of tool name.
 */
export function ToolErrorView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const toolName = extractToolTag(content, "tool-error-name") ?? "";
  const message = extractToolTag(content, "tool-error") ?? content;
  return (
    <Box flexDirection="column">
      <Text bold color="red">
        {toolName.length > 0 ? `${toolName} error` : "Tool error"}
      </Text>
      <Text>{message}</Text>
    </Box>
  );
}

export function BashOutputView({
  content,
  verbose: _verbose,
}: {
  readonly content: string;
  readonly verbose?: boolean;
}): React.ReactElement {
  const stdoutRaw = extractToolTag(content, "bash-stdout") ?? "";
  const stderrRaw = extractToolTag(content, "bash-stderr") ?? "";
  const stdout = truncateForDisplay(stdoutRaw, BASH_OUTPUT_TRUNCATION_LIMIT);
  const stderr = truncateForDisplay(stderrRaw, BASH_OUTPUT_TRUNCATION_LIMIT);
  // Surface the metadata block (e.g. "[exit_code=0 duration_ms=42]")
  // verbatim so the user can read exit-code / duration alongside the
  // captured output without having to expand a verbose mode.
  const metaMatch = content.match(/\[(?:exit_code|duration_ms)[^\]]*\]/);
  const meta = metaMatch ? metaMatch[0] : null;
  // Color the metadata line by exit-code: zero stays dim (success),
  // non-zero turns red so a failed command is visually distinct.
  const exitCodeMatch = content.match(/exit_code=(-?\d+)/);
  const exitCode =
    exitCodeMatch && exitCodeMatch[1] !== undefined
      ? Number.parseInt(exitCodeMatch[1], 10)
      : null;
  const isFailure = exitCode !== null && exitCode !== 0;
  // No-output indicator when the command produced nothing on either
  // stream — keeps the renderer honest about silence instead of
  // showing an apparently-empty box.
  const isSilent = stdoutRaw.length === 0 && stderrRaw.length === 0;
  return (
    <Box flexDirection="column">
      {stdout.length > 0 ? <Text>{stdout}</Text> : null}
      {stderr.length > 0 ? <Text color="red">{stderr}</Text> : null}
      {isSilent ? <Text dimColor>(No output)</Text> : null}
      {meta ? (
        <Text color={isFailure ? "red" : undefined} dimColor={!isFailure}>
          {meta}
        </Text>
      ) : null}
    </Box>
  );
}

type SafeParseResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: Error };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function shortJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 140) return text;
    return `${text.slice(0, 137)}...`;
  } catch {
    return String(value);
  }
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).join("\n");
  if (isRecord(value) && typeof value.content === "string") return value.content;
  return shortJson(value);
}

export function createTuiTool(name: string): any {
  if (name === "AskUserQuestion") {
    return AskUserQuestionTool;
  }
  return {
    name,
    aliases: [],
    maxResultSizeChars: Infinity,
    inputSchema: {
      safeParse(input: unknown): SafeParseResult {
        return { success: true, data: objectFromUnknown(input) };
      },
    },
    async call() {
      return { result: undefined };
    },
    async description() {
      return name;
    },
    async prompt() {
      return `${name} is provided by the AgenC runtime.`;
    },
    async checkPermissions() {
      return { behavior: "ask", message: `Permission required to use ${name}` };
    },
    isConcurrencySafe() {
      return false;
    },
    isEnabled() {
      return true;
    },
    isReadOnly() {
      return false;
    },
    isDestructive() {
      return false;
    },
    toAutoClassifierInput(input: unknown) {
      return input;
    },
    userFacingName() {
      return name;
    },
    getActivityDescription(input: unknown) {
      return `${name} ${shortJson(input)}`;
    },
    renderToolUseMessage(input: unknown) {
      const summary = shortJson(input);
      return summary.length > 0 ? summary : name;
    },
    renderToolResultMessage(
      content: unknown,
      _progress: unknown,
      options?: { readonly verbose?: boolean },
    ) {
      // Per-tool dispatch table. Routes recognized tool results to
      // local upstream-compatible renderers; unrouted tool names fall
      // through to the generic <Text> rendering below. Dispatch
      // decision lives in the JSX-free
      // `tool-result-routing.ts` so unit tests
      // can exercise the routing logic without dragging the upstream
      // component chain into vitest.
      const joined = resultTextForTuiTool(content);
      const target = pickToolResultDispatch(name, joined);
      switch (target) {
        case "tool-error-view":
          return <ToolErrorView content={joined} />;
        case "bash-output-view":
          return (
            <BashOutputView
              content={joined}
              verbose={options?.verbose ?? false}
            />
          );
        case "edit-diff-view":
          return <EditDiffView content={joined} />;
        case "file-read-view":
          return <FileReadView content={joined} />;
        case "file-write-view":
          return <FileWriteView content={joined} />;
        case "grep-matches-view":
          return <GrepMatchesView content={joined} />;
        case "glob-paths-view":
          return <GlobPathsView content={joined} />;
        case "generic":
        default:
          return (
            <Box flexDirection="column">
              <Text>{joined}</Text>
            </Box>
          );
      }
    },
    renderToolUseErrorMessage(error: unknown) {
      // Cross-cutting error path: format and dispatch to ToolErrorView.
      // Any tool whose result reaches this path renders with the same
      // red-bold-header style as the upstream FallbackToolUseErrorMessage.
      const message =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error &&
              typeof (error as { message: unknown }).message === "string"
            ? (error as { message: string }).message
            : shortJson(error);
      const envelope = `<tool-error-name>${name}</tool-error-name>\n<tool-error>${message}</tool-error>`;
      return <ToolErrorView content={envelope} />;
    },
    mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string) {
      return {
        type: "tool_result",
        tool_use_id: toolUseID,
        content: resultTextForTuiTool(content),
      };
    },
  };
}

/**
 * Pre-seed names for tools the TUI dispatches to a structured
 * renderer. These match the live registered tool names in
 * `runtime/src/tools/system/*.ts` (NOT the upstream-product naming —
 * e.g. AgenC's read tool is `FileRead`, not `Read`). If a tool is
 * pre-seeded that the live runtime never registers, the TUI entry
 * is harmless (just unused). If a tool the runtime DOES register is
 * NOT pre-seeded, `createTuiTools` still adds it on the fly when
 * its name flows through `transcript.toolNames`.
 *
 * `Task`, `Agent`, and `mcp__*` names from the previous TUI-only list are
 * intentionally absent: AgenC's agent layer uses `spawn_agent` (a
 * different lifecycle than upstream's Task), and MCP tools are
 * registered with dynamic `mcp__<server>__<tool>` names. Both require
 * a separate dispatch contract beyond exact-case routing.
 */
export function createTuiTools(names: Iterable<string>): readonly any[] {
  const unique = new Set<string>([
    "AskUserQuestion",
    "Bash",
    "Edit",
    "FileRead",
    "Write",
    "Grep",
    "Glob",
  ]);
  for (const name of names) {
    if (name.trim().length > 0) unique.add(name);
  }
  return [...unique].sort().map(createTuiTool);
}
