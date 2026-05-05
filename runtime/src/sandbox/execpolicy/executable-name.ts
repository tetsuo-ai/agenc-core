import path from "node:path";

const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com"] as const;

export function executableLookupKey(raw: string): string {
  if (process.platform !== "win32") return raw;

  const lower = raw.toLowerCase();
  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower;
}

export function executablePathLookupKey(rawPath: string): string | null {
  const basename = path.basename(rawPath);
  if (basename.length === 0 || basename === "." || basename === path.sep) {
    return null;
  }
  return executableLookupKey(basename);
}
