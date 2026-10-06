import { describe, expect, test } from "vitest";

import {
  buildFileMutationMetadata,
  hasFileMutationMetadata,
} from "../../src/tools/result-metadata.js";

describe("hasFileMutationMetadata", () => {
  test("accepts the ui block a single-file edit or write attaches", () => {
    const metadata = buildFileMutationMetadata({
      filePath: "app.py",
      operation: "edit",
      beforeText: "a\n",
      afterText: "b\n",
    });

    expect(hasFileMutationMetadata(metadata)).toBe(true);
    expect(hasFileMutationMetadata({
      ui: {
        kind: "file_mutation",
        filePath: "/tmp/out.txt",
        operation: "create",
        additions: 1,
        removals: 0,
      },
    })).toBe(true);
  });

  test("accepts apply_patch's nonempty fileMutations list", () => {
    expect(hasFileMutationMetadata({
      fileMutations: [{ filePath: "app.py", operation: "edit" }],
    })).toBe(true);
  });

  test.each([
    undefined,
    {},
    { ui: { kind: "diff", filePath: "app.py" } },
    { ui: "file_mutation" },
    { ui: [{ kind: "file_mutation" }] },
    { fileMutations: [] },
    { fileMutations: { filePath: "app.py" } },
    { fileMutations: "app.py" },
  ])("rejects metadata that is not a workspace mutation: %j", (metadata) => {
    expect(hasFileMutationMetadata(metadata)).toBe(false);
  });
});
