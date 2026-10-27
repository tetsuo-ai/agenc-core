import { beforeEach, expect, test, vi } from "vitest";
const probe = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: Object.assign((path: import("node:fs").PathLike, ...rest: unknown[]) => {
    if (String(path).includes("qv-unapproved-network")) {
      probe.paths.push(String(path));
      throw Object.assign(new Error("mock network path blocked"), { code: "ENOENT" });
    }
    return (actual.realpathSync as Function)(path, ...rest);
  }, { native: actual.realpathSync.native }) };
});
import { createFileEditTool } from "../../src/tools/system/file-edit.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { withSignedSessionId } from "../../src/tools/system/filesystem.js";
beforeEach(() => { probe.paths = []; });
test.each(["Edit", "Write"])("%s does no filesystem lookup for an unapproved UNC target", name => {
  const tool = name === "Edit" ? createFileEditTool({ allowedPaths: ["/workspace"] }) : createFileWriteTool({ allowedPaths: ["/workspace"] });
  const input = withSignedSessionId({ file_path: String.raw`\\qv-unapproved-network\share\a.txt`, old_string: "a", new_string: "b", content: "b" }, "qv-unc-repro");
  tool.preflight?.(input);
  expect(probe.paths).toEqual([]);
});
