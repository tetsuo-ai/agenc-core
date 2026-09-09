import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveHomeContext } from "../config/home.js";
import type { PermissionProfile } from "./engine/index.js";

/** Resolve missing leaves through their existing ancestor; never trust a tool's env. */
export function canonicalAuthorityPath(target: string): string {
  let ancestor = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function desktopAuthorityRoot(
  boundHome?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home = boundHome ?? resolveHomeContext(environment).path;
  if (!path.isAbsolute(home)) throw new Error("Desktop authority home must be absolute");
  const root = path.join(canonicalAuthorityPath(home), "desktop-control-authorities");
  try {
    if (!lstatSync(root).isDirectory()) throw new Error("Desktop authority directory must not be a symlink or file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return root;
}

export function isWithinAuthorityPath(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Also disallow file-tool operations naming an ancestor (remove/move/replace). */
export function overlapsDesktopAuthority(target: string, root: string): boolean {
  const canonical = canonicalAuthorityPath(target);
  return isWithinAuthorityPath(canonical, root) || isWithinAuthorityPath(root, canonical);
}

/** Internal, non-grantable reservation. Explicit unsandboxed modes remain operator trust. */
export function protectDesktopAuthority(
  profile: PermissionProfile,
  root: string,
): PermissionProfile {
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      kind: "restricted",
      entries: profile.fileSystem.kind === "restricted" ? profile.fileSystem.entries : [
        { path: { kind: "special", value: { kind: "root" } }, access: "write" },
      ],
      reservedReadOnlyPaths: [...new Set([
        ...(profile.fileSystem.reservedReadOnlyPaths ?? []), root,
      ])],
    },
  };
}
