import path from "node:path";

export function normalizeWorkspacePathForReferences(value: string): string {
  const slashPath = value.replace(/\\/gu, "/");
  if (!slashPath) return slashPath;
  return path.posix.normalize(slashPath).replace(/\/+$/u, "");
}

export function renameWorkspacePathReference(
  value: string | null,
  fromPath: string,
  toPath: string,
): string | null {
  if (!value) return value;
  const normalizedValue = normalizeWorkspacePathForReferences(value);
  const normalizedFromPath = normalizeWorkspacePathForReferences(fromPath);
  const normalizedToPath = normalizeWorkspacePathForReferences(toPath);
  if (!normalizedFromPath) return value;
  if (normalizedValue === normalizedFromPath) return normalizedToPath;
  if (normalizedValue.startsWith(`${normalizedFromPath}/`)) {
    return `${normalizedToPath}${normalizedValue.slice(normalizedFromPath.length)}`;
  }
  return value;
}

export function containsWorkspacePathReference(
  value: string | null,
  targetPath: string,
): boolean {
  if (!value) return false;
  const normalizedValue = normalizeWorkspacePathForReferences(value);
  const normalizedTargetPath = normalizeWorkspacePathForReferences(targetPath);
  if (!normalizedTargetPath) return false;
  return (
    normalizedValue === normalizedTargetPath ||
    normalizedValue.startsWith(`${normalizedTargetPath}/`)
  );
}
