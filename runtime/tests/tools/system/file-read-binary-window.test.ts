import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { attachReadOnlyDelegationReadGuard } from "../../../src/permissions/readonly-read-guard.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-binary-window-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test.each([false, true])("plain reads reject binary bytes past the 8 KB header (delegated=%s)", async delegated => {
  const file = join(root, "mixed.txt");
  await writeFile(file, Buffer.concat([Buffer.from("header\n".repeat(1500)), Buffer.alloc(200_000, 0)]));
  const args = { file_path: file };
  if (delegated) attachReadOnlyDelegationReadGuard(args, () => true);
  const result = await runWithStartupProviderSelection({ provider: "openai", model: "test", environment: {} }, () =>
    bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root], maxTextBytes: 220_000, maxTokens: 1_000_000 })).execute(args));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("cannot read binary files");
});

test.each([false, true])("over-cap reads reject a binary line in the returned window (delegated=%s)", async delegated => {
  const file = join(root, "mixed.txt");
  await writeFile(file, Buffer.concat([Buffer.from("a".repeat(9000) + "\n"), Buffer.alloc(3000, 0), Buffer.from("\n" + "b\n".repeat(20_000))]));
  const args = { file_path: file };
  if (delegated) attachReadOnlyDelegationReadGuard(args, () => true);
  const result = await runWithStartupProviderSelection({ provider: "openai", model: "test", environment: {} }, () =>
    bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root], maxTextBytes: 16_000 })).execute(args));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("cannot read binary files");
});
