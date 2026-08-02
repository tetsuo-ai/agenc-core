import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  bindWorkspaceDirectoryReadCapability,
  captureWorkspaceFilePathTransactionGuard,
} from "../../src/workspace/file-mutation-transaction.js";

describe("Windows descriptor helper transport", () => {
  let root = "";

  afterEach(async () => {
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("starts both authenticated source pipes for reads and structured ripgrep", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-helper-win-"));
    const target = join(root, "target.txt");
    const producer = join(root, "wire-producer.mjs");
    await writeFile(target, "descriptor-bound\n", "utf8");
    await writeFile(
      producer,
      'process.stdout.write("target.txt\\0");\n',
      "utf8",
    );
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const read = await capability.readRelativeFile("target.txt", 4_096);
      expect(read.content.toString("utf8")).toBe("descriptor-bound\n");

      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [producer],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
        structuredLineLimit: {
          outputMode: "files_with_matches",
          maximumLines: 1,
          maximumRecordBytes: 1_024,
          excludedPaths: [],
        },
      });
      expect(result.spawnError).toBeUndefined();
      expect(result.killedAfterLimit).toBe(true);
      expect(result.stdout).toEqual(Buffer.from("target.txt\0", "utf8"));
    } finally {
      await capability.dispose();
    }
  });

  test("starts the authenticated directory helper before a missing-file mutation", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-mutation-win-"));
    const target = join(root, "created.txt");
    const content = Buffer.from("created through bound helper\n", "utf8");
    const missing = { kind: "missing" as const };
    const created = { kind: "content" as const, content };
    const guard = await captureWorkspaceFilePathTransactionGuard(target);

    try {
      expect(guard.targetExisted).toBe(false);
      await guard.prepareBoundMutation(missing, "write");
      await guard.writeBoundContent(missing, content);
      await guard.assertState(created);
      await expect(readFile(target, "utf8")).resolves.toBe(
        "created through bound helper\n",
      );
    } finally {
      await guard.dispose();
    }
  });
});
