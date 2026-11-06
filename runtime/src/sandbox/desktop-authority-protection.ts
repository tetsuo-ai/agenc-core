import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveHomeContext } from "../config/home.js";
import type { PermissionProfile } from "./engine/index.js";

function resolveExistingAuthorityPath(target: string): string {
  if (process.platform === "linux") {
    try {
      return realpathSync.native(target);
    } catch {
      // Preserve the existing resolver's result/error on native misses. Some
      // libc environments need /proc for native realpath; authority checks
      // must not change when that implementation is unavailable.
    }
  }
  return realpathSync(target);
}

/** Resolve missing leaves through their existing ancestor; never trust a tool's env. */
export function canonicalAuthorityPath(target: string): string {
  let ancestor = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(resolveExistingAuthorityPath(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

const PATH_PARTS = process.platform === "win32" ? /[\\/]+/u : /\/+/u;
/** More links on one path than any real layout needs: refuse, as the OS does. */
const MAX_WRITE_LANDING_LINKS = 40;

/**
 * Where a write to `target` lands once every link on its path is followed,
 * a dangling one too (a write through it creates the link's target), each
 * relative link read from the folder that holds it and a `..` after it taken
 * from where it led. {@link canonicalAuthorityPath} keeps a dangling link's
 * own name instead. Throws ELOOP past {@link MAX_WRITE_LANDING_LINKS} links.
 */
export function writeLandingAuthorityPath(target: string): string {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  let pending = absolute.slice(current.length).split(PATH_PARTS).filter(Boolean);
  let followed = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch {
      // Missing: created by the write, nothing to follow.
    }
    if (!isLink) {
      current = candidate;
      continue;
    }
    if (++followed > MAX_WRITE_LANDING_LINKS) {
      throw Object.assign(new Error(`too many links on the way to ${target}`), { code: "ELOOP" });
    }
    const link = readlinkSync(candidate);
    if (path.isAbsolute(link)) current = path.parse(link).root;
    pending = [...link.slice(path.isAbsolute(link) ? path.parse(link).root.length : 0).split(PATH_PARTS).filter(Boolean), ...pending];
  }
  // No link is left on the way; spell the existing part the way real paths
  // are spelled (case, short names), as the writable roots are.
  return canonicalAuthorityPath(current);
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
