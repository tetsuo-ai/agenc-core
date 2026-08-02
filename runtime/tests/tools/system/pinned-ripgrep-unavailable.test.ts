import {
  access,
  copyFile,
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("../../../src/tools/system/pinned-ripgrep.js");
  vi.doUnmock("../../../src/utils/supervisedProcess.js");
  vi.resetModules();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("unavailable pinned ripgrep production defaults", () => {
  it("never invokes an executable planted at the unavailable path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-planted-rg-"));
    temporaryRoots.push(root);
    const marker = join(root, "invoked");
    const planted = join(
      root,
      process.platform === "win32" ? "planted-rg.exe" : "planted-rg",
    );
    if (process.platform === "win32") {
      await copyFile(process.execPath, planted);
    } else {
      await writeFile(
        planted,
        `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 0\n`,
        "utf8",
      );
      await chmod(planted, 0o755);
    }

    const processCalls: unknown[][] = [];
    vi.doMock("../../../src/tools/system/pinned-ripgrep.js", () => ({
      PINNED_RIPGREP_AVAILABLE: false,
      PINNED_RIPGREP_PATH: planted,
      selectPinnedRipgrepPath: (
        state = {
          available: false,
          path: planted,
        },
      ) =>
        state.available && state.path !== undefined ? state.path : undefined,
    }));
    vi.doMock(
      "../../../src/utils/supervisedProcess.js",
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("../../../src/utils/supervisedProcess.js")
          >();
        return {
          ...actual,
          runSupervisedProcess: async (...args: unknown[]) => {
            processCalls.push(args);
            throw new Error("planted pinned ripgrep reached process runner");
          },
        };
      },
    );

    const [{ createGrepTool }, { createGlobTool }, { createOrientTool }] =
      await Promise.all([
        import("../../../src/tools/system/grep.js"),
        import("../../../src/tools/system/glob.js"),
        import("../../../src/tools/system/orient.js"),
      ]);
    const tools = [
      {
        tool: bindExplicitDangerBoundary(
          createGrepTool({ allowedPaths: [root] }),
        ),
        input: { pattern: "needle", path: root },
        label: "Grep",
      },
      {
        tool: bindExplicitDangerBoundary(
          createGlobTool({ allowedPaths: [root] }),
        ),
        input: { pattern: "**/*", path: root },
        label: "Glob",
      },
      {
        tool: bindExplicitDangerBoundary(
          createOrientTool({ allowedPaths: [root] }),
        ),
        input: { query: "needle", path: root },
        label: "Orient",
      },
    ];

    expect(processCalls).toHaveLength(0);
    await expect(access(marker)).rejects.toThrow();
    for (const entry of tools) {
      const result = await entry.tool.execute(entry.input);
      expect(result.isError).toBe(true);
      expect(result.content).toContain(entry.label);
      expect(result.content).toContain("PINNED_RIPGREP_UNAVAILABLE");
    }
    expect(processCalls).toHaveLength(0);
    await expect(access(marker)).rejects.toThrow();
  });
});
