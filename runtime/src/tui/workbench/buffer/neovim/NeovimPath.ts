import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

/**
 * Return one physical identity for a Neovim file path, including paths whose
 * final components do not exist yet.
 *
 * Neovim reports canonical absolute buffer names on some platforms. Darwin,
 * for example, reports `/private/tmp/...` for a file opened through `/tmp/...`.
 * Resolve the deepest existing ancestor so missing rename targets still share
 * the same identity namespace as live editor buffers.
 */
export function canonicalNeovimPath(
  candidatePath: string,
  basePath?: string,
): string {
  // Do not call path.resolve() before realpath. Lexically collapsing
  // `symlink/..` can produce a different location than filesystem traversal
  // and would make a path outside the workspace look in-bounds.
  const absolutePath = isAbsolute(candidatePath)
    ? candidatePath
    : `${canonicalNeovimPath(basePath ?? process.cwd())}${sep}${candidatePath}`;
  const missingComponents: string[] = [];
  let existingAncestor = absolutePath;

  while (true) {
    try {
      return resolve(
        realpathSync.native(existingAncestor),
        ...missingComponents,
      );
    } catch (error) {
      if (
        !isFsErrorCode(error, "ENOENT") &&
        !isFsErrorCode(error, "ENOTDIR")
      ) {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingComponents.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

export function canonicalNeovimPathKey(pathValue: string): string {
  const canonical = canonicalNeovimPath(pathValue);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function canonicalNeovimPathIsAtOrWithin(
  candidatePath: string,
  parentPath: string,
): boolean {
  const pathFromParent = relative(
    canonicalNeovimPath(parentPath),
    canonicalNeovimPath(candidatePath),
  );
  return pathFromParent.length === 0 ||
    (
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent)
    );
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
