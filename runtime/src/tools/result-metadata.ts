import { structuredPatch } from "diff";

const DIFF_TIMEOUT_MS = 1_000;

export type FileMutationOperation = "create" | "write" | "edit";

export interface FileMutationUiMetadata {
  readonly kind: "file_mutation";
  readonly filePath: string;
  readonly operation: FileMutationOperation;
  readonly additions: number;
  readonly removals: number;
  readonly replacements?: number;
}

export interface FileMutationMetadataInput {
  readonly filePath: string;
  readonly operation: FileMutationOperation;
  readonly beforeText: string;
  readonly afterText: string;
  readonly replacements?: number;
}

export type RecoverableToolFailureKind =
  | "input_validation"
  | "mcp_tool_not_shell_command"
  | "shell_workspace_write_policy";

export interface RecoverableToolFailureMetadata {
  readonly recoverable: true;
  readonly hiddenFromTranscript: true;
  readonly kind: RecoverableToolFailureKind;
}

export function buildRecoverableToolFailureMetadata(
  kind: RecoverableToolFailureKind,
  existing: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...existing,
    recoverable: true,
    hiddenFromTranscript: true,
    kind,
  };
}

export function recoverableFailureKind(
  metadata: Readonly<Record<string, unknown>> | undefined,
): RecoverableToolFailureKind | null {
  if (!metadata) return null;
  if (metadata.recoverable !== true) return null;
  if (metadata.hiddenFromTranscript !== true) return null;
  return metadata.kind === "input_validation" ||
    metadata.kind === "mcp_tool_not_shell_command" ||
    metadata.kind === "shell_workspace_write_policy"
    ? metadata.kind
    : null;
}

export function isHiddenRecoverableToolFailure(
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return recoverableFailureKind(metadata) !== null;
}

export function compactRecoverableToolFailureMessage(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | null {
  const kind = recoverableFailureKind(metadata);
  switch (kind) {
    case "input_validation":
      return "Invalid tool parameters";
    case "mcp_tool_not_shell_command":
      return "MCP tool used as shell command";
    case "shell_workspace_write_policy":
      return "Shell write blocked";
    default:
      return null;
  }
}

export function buildFileMutationMetadata(
  input: FileMutationMetadataInput,
): Record<string, unknown> {
  const patch = structuredPatch(
    input.filePath,
    input.filePath,
    input.beforeText,
    input.afterText,
    undefined,
    undefined,
    { context: 3, timeout: DIFF_TIMEOUT_MS },
  );

  let additions = 0;
  let removals = 0;
  for (const hunk of patch?.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) removals += 1;
    }
  }

  const ui: FileMutationUiMetadata = {
    kind: "file_mutation",
    filePath: input.filePath,
    operation: input.operation,
    additions,
    removals,
    ...(input.replacements !== undefined
      ? { replacements: input.replacements }
      : {}),
  };
  return { ui };
}
