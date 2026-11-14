import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { attachReadOnlyDelegationReadGuard } from "../../../src/permissions/readonly-read-guard.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

test("a delegated plain read preserves the actionable fallback cap error", async () => {
  const root = await mkdtemp(join(tmpdir(), "read-delegated-cap-"));
  try {
    const file = join(root, "one.min.js");
    await writeFile(file, "x".repeat(1000));
    const args = { file_path: file };
    attachReadOnlyDelegationReadGuard(args, () => true);
    const result = await runWithStartupProviderSelection({ provider: "openai", model: "test", environment: {} }, () =>
      createFileReadTool({ allowedPaths: [root], maxTextBytes: 16 }).execute(args));
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File slice exceeds the text-read limit of 16B. Use a smaller offset and limit window.");
  } finally { await rm(root, { recursive: true, force: true }); }
});
