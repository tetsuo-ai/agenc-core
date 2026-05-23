export function normalizeWorkspacePathForReferences(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

export function renameWorkspacePathReference(
  value: string | null,
  fromPath: string,
  toPath: string,
): string | null {
  if (!value) return value;
  const normalizedFromPath = normalizeWorkspacePathForReferences(fromPath);
  const normalizedToPath = normalizeWorkspacePathForReferences(toPath);
  if (!normalizedFromPath) return value;
  if (value === normalizedFromPath) return normalizedToPath;
  if (value.startsWith(`${normalizedFromPath}/`)) {
    return `${normalizedToPath}${value.slice(normalizedFromPath.length)}`;
  }
  return value;
}

export function containsWorkspacePathReference(
  value: string | null,
  targetPath: string,
): boolean {
  if (!value) return false;
  const normalizedTargetPath = normalizeWorkspacePathForReferences(targetPath);
  if (!normalizedTargetPath) return false;
  return (
    value === normalizedTargetPath ||
    value.startsWith(`${normalizedTargetPath}/`)
  );
}
