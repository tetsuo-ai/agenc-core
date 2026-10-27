import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repositoryRoot = resolve(runtimeRoot, "..");

/**
 * A writable directory that resolves like a child of runtime/: "../src/..."
 * reaches runtime/src, and bare imports reach runtime/node_modules and then
 * the repository's hoisted node_modules. The release test boundary mounts the
 * repository read-only, so tests must not create files inside it.
 */
export async function makeRuntimeScratch(prefix: string): Promise<{
  readonly directory: string;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const runtime = join(root, "runtime");
    await mkdir(runtime);
    await symlink(join(runtimeRoot, "src"), join(runtime, "src"), "dir");
    for (const [target, link] of [
      [join(runtimeRoot, "node_modules"), join(runtime, "node_modules")],
      [join(repositoryRoot, "node_modules"), join(root, "node_modules")],
    ] as const) {
      if (existsSync(target)) await symlink(target, link, "dir");
    }
    const directory = join(runtime, "scratch");
    await mkdir(directory);
    return { directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
