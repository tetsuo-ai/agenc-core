import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const runtimeRootPath = fileURLToPath(new URL("../../", import.meta.url));
export const runtimeSourceRootPath = resolve(runtimeRootPath, "src");

export function sourcePath(...parts: readonly string[]): string {
  return resolve(runtimeSourceRootPath, ...parts);
}

export function sourceUrl(...parts: readonly string[]): URL {
  return pathToFileURL(sourcePath(...parts));
}
