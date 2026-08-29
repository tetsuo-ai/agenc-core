import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface ConfigSourceIdentityInput {
  readonly label: string;
  readonly path: string;
}

export interface ConfigSourceCollision {
  readonly first: ConfigSourceIdentityInput;
  readonly second: ConfigSourceIdentityInput;
  readonly reason: "path" | "realpath" | "inode";
}

interface ResolvedSourceIdentity {
  readonly input: ConfigSourceIdentityInput;
  readonly path: string;
  readonly canonicalPath: string;
  readonly inode?: string;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path;
  }
}

async function sourceIdentity(
  input: ConfigSourceIdentityInput,
): Promise<ResolvedSourceIdentity> {
  const path = resolve(input.path);
  const canonical = await canonicalPath(path);
  let inode: string | undefined;
  try {
    const info = await stat(path);
    if (info.dev !== 0 || info.ino !== 0) inode = `${info.dev}:${info.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Object.freeze({
    input: Object.freeze({ ...input, path }),
    path,
    canonicalPath: canonical,
    ...(inode !== undefined ? { inode } : {}),
  });
}

/**
 * Find every pair of configuration authorities that resolves to one file.
 * Text paths, symlinked parents/targets, and hard links are all covered.
 */
export async function findConfigSourceCollisions(
  inputs: readonly ConfigSourceIdentityInput[],
): Promise<readonly ConfigSourceCollision[]> {
  const identities = await Promise.all(inputs.map(sourceIdentity));
  const collisions: ConfigSourceCollision[] = [];
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    const first = identities[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < identities.length;
      rightIndex += 1
    ) {
      const second = identities[rightIndex]!;
      const reason = first.path === second.path
        ? "path"
        : first.canonicalPath === second.canonicalPath
          ? "realpath"
          : first.inode !== undefined && first.inode === second.inode
            ? "inode"
            : undefined;
      if (reason === undefined) continue;
      collisions.push(Object.freeze({
        first: first.input,
        second: second.input,
        reason,
      }));
    }
  }
  return Object.freeze(collisions);
}
