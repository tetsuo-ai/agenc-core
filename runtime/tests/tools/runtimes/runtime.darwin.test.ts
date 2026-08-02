import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { safePath } from "../../tools/system/filesystem.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import { WorkspaceMutationCoordinatorRegistry } from "../../workspace/mutation-coordinator.js";
import { permissionProfileForRuntimeContext } from "./sandboxing.js";

if (process.platform !== "darwin") {
  throw new Error("the native Seatbelt integration test requires macOS");
}

test(
  "live default workspace-write policy launches pwd through macOS Seatbelt",
  async () => {
    const cwd = process.cwd();
    const profile = permissionProfileForRuntimeContext(
      {
        sandboxMode: "workspace_write",
        invocation: {
          turn: {
            cwd,
            fileSystemSandboxPolicy: {
              allowWrite: [cwd],
              denyWrite: [],
              allowRead: [],
              denyRead: [],
            },
          },
        },
      } as never,
      { cwd },
    );
    const manager = new UnifiedExecProcessManager({ cwd });

    try {
      const result = await manager.execCommand({
        cmd: "pwd",
        yield_time_ms: 1_000,
        runtimeSandbox: {
          permissionProfile: profile,
          sandboxPolicyCwd: cwd,
          preference: "require",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(cwd);
    } finally {
      await manager.closeAll("test cleanup");
    }
  },
);

test(
  "derives Unicode pathname identity from the mounted macOS volume",
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "agenc-darwin-path-identity-"),
    );
    const decomposedRoot = join(temporaryRoot, "cafe\u0301");
    const composedRoot = join(temporaryRoot, "caf\u00e9");
    const agencHome = join(temporaryRoot, "agenc-home");

    try {
      await mkdir(decomposedRoot);
      let createdDistinctSpelling = true;
      try {
        await mkdir(composedRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        createdDistinctSpelling = false;
      }

      const [decomposedIdentity, composedIdentity] = await Promise.all([
        stat(decomposedRoot, { bigint: true }),
        stat(composedRoot, { bigint: true }),
      ]);
      const spellingsAliasSameEntry =
        decomposedIdentity.dev === composedIdentity.dev &&
        decomposedIdentity.ino === composedIdentity.ino;

      // The empty temporary directory makes creation outcome an independent
      // check on the object identity observed through stat. This deliberately
      // avoids treating every Darwin volume as normalization-insensitive APFS.
      expect(createdDistinctSpelling).toBe(!spellingsAliasSameEntry);

      const pathCheck = await safePath(composedRoot, [decomposedRoot]);
      const registry = new WorkspaceMutationCoordinatorRegistry({ agencHome });
      const decomposedCoordinator = registry.getOrCreate(decomposedRoot);
      const composedCoordinator = registry.getOrCreate(composedRoot);

      if (spellingsAliasSameEntry) {
        expect(pathCheck.safe).toBe(true);
        const resolvedIdentity = await stat(pathCheck.resolved, {
          bigint: true,
        });
        expect(resolvedIdentity.dev).toBe(decomposedIdentity.dev);
        expect(resolvedIdentity.ino).toBe(decomposedIdentity.ino);
        expect(composedCoordinator).toBe(decomposedCoordinator);
      } else {
        expect(pathCheck).toMatchObject({
          safe: false,
          resolved: "",
          reason: "Path is outside allowed directories",
        });
        expect(composedCoordinator).not.toBe(decomposedCoordinator);
        expect(composedCoordinator.workspaceRoot).toBe(composedRoot);
        expect(decomposedCoordinator.workspaceRoot).toBe(decomposedRoot);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
