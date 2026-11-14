import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { bindWorkspaceFileReadCapability } from "../../../src/workspace/file-mutation-transaction.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

let root: string;
let file: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "read-count-budget-"));
  file = join(root, "large.txt");
  await writeFile(file, "a\n".repeat(1_100_000) + "target\nnext\n" + "b\n".repeat(1_100_000));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

for (const bound of [false, true]) {
  test.each([1, 1_100_001])(`counting is bounded while the requested window stays exact (bound=${bound}, offset=%s)`, async offset => {
    const expected = offset === 1 ? "a\na" : "target\nnext";
    if (bound) {
      const capability = await bindWorkspaceFileReadCapability(file);
      try {
        const result = await capability.readTextWindow(offset, 2, 32, true);
        expect(result).toMatchObject({ content: expected, startLine: offset, endLine: offset + 1,
          numLines: 2, totalLinesIsLowerBound: true });
        expect(result.totalLines).toBeLessThan(offset + 600_000);
      } finally { await capability.dispose(); }
    } else {
      const result = await runWithStartupProviderSelection({ provider: "openai", model: "test", environment: {} }, () =>
        bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root], maxTextBytes: 32 }))
          .execute({ file_path: file, offset, limit: 2 }));
      expect(result.isError).toBeUndefined();
      expect(result.content).toMatch(new RegExp(`^${offset}→${expected.replace("\n", `\\n${offset + 1}→`)}\\n\\[lines ${offset}-${offset + 1} of at least \\d+; next offset ${offset + 2}\\]$`));
      expect(result.metadata?.totalLinesIsLowerBound).toBe(true);
      expect(result.metadata?.totalLines).toBeLessThan(offset + 600_000);
    }
  });
}
