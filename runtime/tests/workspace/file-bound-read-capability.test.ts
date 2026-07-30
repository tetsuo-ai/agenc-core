import {
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  __setWorkspaceBoundReadNoFollowForTests,
  bindWorkspaceDirectoryReadCapability,
  bindWorkspaceFileReadCapability,
} from "../../src/workspace/file-mutation-transaction.js";

describe("descriptor-bound file reads", () => {
  let root = "";

  afterEach(async () => {
    __setWorkspaceBoundReadNoFollowForTests(undefined);
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("portable no-O_NOFOLLOW fallback rejects a replaced leaf", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-"));
    const target = join(root, "target.txt");
    const displaced = join(root, "target-inside.txt");
    const outside = join(root, "outside.txt");
    await writeFile(target, "inside-portable-proof\n", "utf8");
    await writeFile(outside, "outside-portable-secret\n", "utf8");
    __setWorkspaceBoundReadNoFollowForTests(false);
    const capability = await bindWorkspaceFileReadCapability(target);

    try {
      const admitted = await capability.readFile(4096);
      expect(admitted.content.toString("utf8")).toBe("inside-portable-proof\n");
      expect(typeof admitted.stats.dev).toBe("string");
      expect(typeof admitted.stats.ino).toBe("string");

      await rename(target, displaced);
      if (process.platform === "win32") {
        // Creating a file symlink can require Developer Mode/admin on Windows;
        // an outside hardlink still proves admitted-identity enforcement.
        await link(outside, target);
      } else {
        // O_NOFOLLOW is deliberately disabled above. The pre-open regular-file
        // proof must reject this link before any outside descriptor is read.
        await symlink(outside, target, "file");
      }

      await expect(capability.readFile(4096)).rejects.toThrow();
    } finally {
      await capability.dispose();
    }
  });

  test("bound subprocess timeout is reported and leaves the helper reusable", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-timeout-"));
    const target = join(root, "target.txt");
    const stall = join(root, "stall.mjs");
    await writeFile(target, "still-readable\n", "utf8");
    await writeFile(stall, "setInterval(() => {}, 1_000);\n", "utf8");
    const capability = await bindWorkspaceDirectoryReadCapability(root);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [stall],
        env: {},
        timeoutMs: 50,
        maxOutputBytes: 4096,
      });

      expect(result.stopReason).toBe("timeout");
      expect(result.aborted).toBe(false);
      const read = await capability.readRelativeFile("target.txt", 4096);
      expect(read.content.toString("utf8")).toBe("still-readable\n");
    } finally {
      await capability.dispose();
    }
  });

  test("bound subprocess abort terminates promptly and disposes cleanly", async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-bound-read-abort-"));
    const stall = join(root, "stall.mjs");
    await writeFile(stall, "setInterval(() => {}, 1_000);\n", "utf8");
    const capability = await bindWorkspaceDirectoryReadCapability(root);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25);

    try {
      const result = await capability.runRipgrep({
        program: process.execPath,
        args: [stall],
        env: {},
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        signal: controller.signal,
      });

      expect(result.aborted).toBe(true);
      expect(result.stopReason).toBe("aborted");
    } finally {
      clearTimeout(abortTimer);
      await expect(capability.dispose()).resolves.toBeUndefined();
    }
  });
});
