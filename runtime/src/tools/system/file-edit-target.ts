/**
 * The file a Write/Edit/MultiEdit input targets: `file_path`, or `path` in the
 * batch Edit form ({path, edits:[{oldText, newText}]}) that DeepSeek Light uses.
 * Guards and policies that inspect a write's target must read both spellings.
 */
export function fileEditTargetPath(input: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof input.file_path === "string") return input.file_path;
  return Array.isArray(input.edits) && typeof input.path === "string" ? input.path : undefined;
}

/** The argument key that carries {@link fileEditTargetPath}, for policies that canonicalize it. */
export function fileEditTargetKey(input: Readonly<Record<string, unknown>>): "file_path" | "path" {
  return typeof input.file_path !== "string" && Array.isArray(input.edits) && typeof input.path === "string"
    ? "path"
    : "file_path";
}

function isBatchEditInput(toolName: string, input: Readonly<Record<string, unknown>>): boolean {
  return toolName === "Edit" && input.file_path === undefined && Array.isArray(input.edits) &&
    typeof input.path === "string";
}

/**
 * Hook-facing view of a tool input. The batch Edit also carries `file_path`, the key Edit hooks have
 * always read, so existing user hooks keep working; every other input is returned unchanged.
 */
export function hookToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  return isBatchEditInput(toolName, input) ? { ...input, file_path: input.path } : input;
}

/**
 * Maps a PreToolUse hook's updatedInput back to the batch Edit schema. `file_path` exists only in the
 * hook-facing view: a hook that echoes it, or redirects the edit through it, must not make the call
 * fail strict validation. A hook that changes `path` itself keeps that change.
 */
export function toolInputFromHook(
  toolName: string,
  original: Record<string, unknown>,
  updated: Record<string, unknown>,
): Record<string, unknown> {
  if (!isBatchEditInput(toolName, original) || !Object.hasOwn(updated, "file_path")) return updated;
  const { file_path: hookPath, ...rest } = updated;
  if (typeof hookPath === "string" && hookPath !== original.path &&
    (rest.path === undefined || rest.path === original.path)) {
    return { ...rest, path: hookPath };
  }
  return rest;
}
