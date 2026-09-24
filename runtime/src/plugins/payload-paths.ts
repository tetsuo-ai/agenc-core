import { relative, resolve, win32 } from "node:path";

/** These directories are excluded from the signed plugin payload. */
export function isExcludedPluginPayloadDirectory(name: string): boolean {
  // Windows ignores trailing dots/spaces and common plugin stores also live on
  // case-insensitive volumes. Exclusion must use the filesystem's broadest
  // possible identity, even when the host running validation differs.
  const equivalent = name.replace(/[. ]+$/u, "").toLowerCase();
  return equivalent === ".git" || equivalent === ".hg" || equivalent === ".svn";
}

export function isExcludedPluginPayloadPath(pluginRoot: string, path: string): boolean {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(pluginRoot) ||
    /^[A-Za-z]:[\\/]|^\\\\/u.test(path);
  const child = windows
    ? win32.relative(win32.resolve(pluginRoot), win32.resolve(path))
    : relative(resolve(pluginRoot), resolve(path));
  return child.split(/[\\/]/u).some(isExcludedPluginPayloadDirectory);
}

/** Signature and install records are deliberately outside the signed payload. */
export function isUnsignedPluginMetadataPath(pluginRoot: string, path: string): boolean {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(pluginRoot) ||
    /^[A-Za-z]:[\\/]|^\\\\/u.test(path);
  const child = windows
    ? win32.relative(win32.resolve(pluginRoot), win32.resolve(path))
    : relative(resolve(pluginRoot), resolve(path));
  const parts = child.split(/[\\/]/u)
    .map((part) => part.replace(/[. ]+$/u, "").toLowerCase());
  return parts.length === 2 && parts[0] === ".agenc-plugin" &&
    (parts[1] === "signature.json" || parts[1] === "agenc-install.json");
}
