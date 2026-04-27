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
