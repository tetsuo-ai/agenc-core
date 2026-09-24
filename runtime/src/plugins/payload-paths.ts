import { relative, resolve } from "node:path";

/** These directories are excluded from the signed plugin payload. */
export function isExcludedPluginPayloadDirectory(name: string): boolean {
  return name === ".git" || name === ".hg" || name === ".svn";
}

export function isExcludedPluginPayloadPath(pluginRoot: string, path: string): boolean {
  const child = relative(resolve(pluginRoot), resolve(path)).replace(/\\/gu, "/");
  return child.split("/").some(isExcludedPluginPayloadDirectory);
}
