import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempWorkspaceFixture {
  /** Create and track a unique, existing absolute workspace directory. */
  create(): Promise<string>;

  /** Remove every workspace created since the previous cleanup. */
  cleanup(): Promise<void>;
}

/**
 * Build a per-test-file workspace fixture.
 *
 * `mkdtemp` makes each directory unique across parallel Vitest workers. The
 * fixture tracks only directories it created, and cleanup is idempotent so an
 * `afterEach` hook can safely reclaim every workspace even after a test fails.
 */
export function createTempWorkspaceFixture(
  prefix = "agenc-test-workspace-",
): TempWorkspaceFixture {
  const paths = new Set<string>();

  return {
    async create(): Promise<string> {
      const path = await mkdtemp(join(tmpdir(), prefix));
      paths.add(path);
      return path;
    },

    async cleanup(): Promise<void> {
      await Promise.all(
        [...paths].map(async (path) => {
          await rm(path, { recursive: true, force: true });
          paths.delete(path);
        }),
      );
    },
  };
}
