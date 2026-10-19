/**
 * A descriptor-bound Grep launches pinned ripgrep only for real work: the
 * search is its own availability probe, so no separate `--version` launch
 * precedes it, and a launch that cannot execute ripgrep still fails closed
 * with PINNED_RIPGREP_UNAVAILABLE.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceBoundReadCapability } from "../../../src/workspace/file-mutation-transaction.js";

type RunRipgrep = WorkspaceBoundReadCapability["runRipgrep"];
const roots: string[] = [];

afterEach(async () => {
  vi.doUnmock("../../../src/workspace/lazy-file-mutation.js");
  vi.resetModules();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function grepWithLaunches(
  override?: (run: RunRipgrep, input: Parameters<RunRipgrep>[0]) => ReturnType<RunRipgrep>,
) {
  const launches: string[][] = [];
  vi.doMock("../../../src/workspace/lazy-file-mutation.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/workspace/lazy-file-mutation.js")>();
    const wrap = (capability: WorkspaceBoundReadCapability): WorkspaceBoundReadCapability => {
      const run = capability.runRipgrep;
      return Object.assign(Object.create(Object.getPrototypeOf(capability)), capability, {
        runRipgrep: (input: Parameters<RunRipgrep>[0]) => {
          launches.push([...input.args]);
          return override === undefined ? run(input) : override(run, input);
        },
      });
    };
    return {
      ...actual,
      bindWorkspaceDirectoryReadCapability: async (...args: Parameters<typeof actual.bindWorkspaceDirectoryReadCapability>) =>
        wrap(await actual.bindWorkspaceDirectoryReadCapability(...args)),
      bindWorkspaceFileReadCapability: async (...args: Parameters<typeof actual.bindWorkspaceFileReadCapability>) =>
        wrap(await actual.bindWorkspaceFileReadCapability(...args)),
    };
  });
  // Import after the mock so the tool and its runtime boundary share one module graph.
  const [{ createGrepTool, __resetRipgrepProbeForTests }, { bindExplicitDangerBoundary }] = await Promise.all([
    import("../../../src/tools/system/grep.js"),
    import("../../helpers/explicit-danger-boundary.js"),
  ]);
  __resetRipgrepProbeForTests();
  const root = await mkdtemp(join(tmpdir(), "agenc-grep-launch-"));
  roots.push(root);
  await writeFile(join(root, "a.txt"), "alpha needle\n", "utf8");
  const tool = bindExplicitDangerBoundary(createGrepTool({ allowedPaths: [root] }));
  const result = await tool.execute({ pattern: "needle", path: root, output_mode: "content" });
  return { result, launches };
}

describe.skipIf(process.platform === "win32")("descriptor-bound Grep launches", () => {
  it("runs no separate --version probe before the bound search", async () => {
    const { result, launches } = await grepWithLaunches();
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("needle");
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.filter((args) => args.includes("--version"))).toEqual([]);
  });

  it("reports PINNED_RIPGREP_UNAVAILABLE when the bound launch cannot execute ripgrep", async () => {
    const { result } = await grepWithLaunches(async () => ({
      stdout: Buffer.alloc(0), stderr: Buffer.from("exec failed"), exitCode: 127, signal: null,
      killedAfterLimit: false, processedLines: 0, workUnits: 0, spooledBytes: 0, aborted: false,
    }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("PINNED_RIPGREP_UNAVAILABLE");
    expect(result.content).toContain("agenc doctor");
  });
});
