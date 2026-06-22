import path from "node:path";

export function resolveRuntimePathTarget(value: string, cwd: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(cwd, value);
}
