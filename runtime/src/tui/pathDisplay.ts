import { relativePath } from "../utils/permissions/filesystem.js";

export function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);
}

export function isRelativePathOutsideBase(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === ".." || normalized.startsWith("../") || isAbsoluteLikePath(path);
}

export function displayPathRelativeToBase(basePath: string, targetPath: string): string {
  if (!isAbsoluteLikePath(targetPath)) return targetPath;
  const relative = relativePath(basePath, targetPath);
  if (!relative || isRelativePathOutsideBase(relative)) return targetPath;
  return relative;
}
