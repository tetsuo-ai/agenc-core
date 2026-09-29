import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { withSignedAllowedRoots } from "../../../src/agents/_deps/filesystem-args.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import { createFileMultiEditTool } from "../../../src/tools/system/file-edit.js";

let root: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "light-write-"));
  workspace = join(root, "repo");
  await mkdir(workspace);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test.each(["Write", "MultiEdit"])("%s rejects a sibling artifact before creating its parent", async name => {
  const config = { allowedPaths: [workspace], lightMode: true };
  const tool = name === "Write" ? createFileWriteTool(config) : createFileMultiEditTool(config);
  const target = join(root, "repo-duplicated", "script.sh");
  const args = name === "Write"
    ? { file_path: target, content: "hello", __testBypassSessionGuard: true }
    : { file_path: target, edits: [{ old_string: "", new_string: "hello" }] };
  const result = await tool.execute(withSignedAllowedRoots(args, [root]));
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("relative to the workspace");
  expect(result.effectDisposition).toBeDefined();
  await expect(stat(join(root, "repo-duplicated"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("Light creates a relative artifact and rejects a symlink into a sibling", async () => {
  const tool = createFileWriteTool({ allowedPaths: [workspace], lightMode: true });
  const ok = await tool.execute({ file_path: "new.txt", content: "local", __testBypassSessionGuard: true });
  expect(ok.isError).toBeUndefined();
  await expect(readFile(join(workspace, "new.txt"), "utf8")).resolves.toBe("local");
  await mkdir(join(root, "sibling"));
  await symlink(join(root, "sibling"), join(workspace, "link"));
  const denied = await tool.execute(withSignedAllowedRoots({ file_path: "link/new.txt", content: "no", __testBypassSessionGuard: true }, [root]));
  expect(denied.isError).toBe(true);
  await expect(stat(join(root, "sibling", "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("normal sessions retain an explicitly admitted additional root", async () => {
  const tool = createFileWriteTool({ allowedPaths: [workspace] });
  const target = join(root, "extra.txt");
  const result = await tool.execute(withSignedAllowedRoots({ file_path: target, content: "allowed", __testBypassSessionGuard: true }, [root]));
  expect(result.isError).toBeUndefined();
  await expect(readFile(target, "utf8")).resolves.toBe("allowed");
});
