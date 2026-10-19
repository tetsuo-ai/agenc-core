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
