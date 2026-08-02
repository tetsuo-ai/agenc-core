import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const pinnedRipgrep = vi.hoisted(() => ({ path: "" }));

vi.mock("./pinned-ripgrep.js", () => ({
  selectPinnedRipgrepPath: () => pinnedRipgrep.path || undefined,
}));

import { __resetRipgrepProbeForTests, createGrepTool } from "./grep.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { workspaceMutationCoordinators } from "../../../src/workspace/mutation-coordinator.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  pinnedRipgrep.path = "";
  __resetRipgrepProbeForTests();
  workspaceMutationCoordinators.clearForTests();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("protected Grep scoped-directory confinement", () => {
  test("rejects a sibling candidate emitted by untrusted discovery metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-grep-subdir-"));
    temporaryRoots.push(root);
    const scoped = join(root, "scoped");
    const sibling = join(root, "sibling");
    await mkdir(scoped);
    await mkdir(sibling);
    await writeFile(join(scoped, "inside.txt"), "inside needle\n", "utf8");
    await writeFile(
      join(sibling, "secret.txt"),
      "sibling secret needle\n",
      "utf8",
    );
    const fakeScript = join(root, "fake-rg.mjs");
    const fakeExecutable =
      process.platform === "win32" ? join(root, "fake-rg.cmd") : fakeScript;
    await writeFile(
      fakeScript,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("ripgrep 14.1.1\\n");
} else if (args.at(-1) === "-") {
  process.stdout.write("<stdin>\\0");
} else {
  process.stdout.write("sibling/secret.txt\\0");
}
`,
      "utf8",
    );
    if (process.platform === "win32") {
      await writeFile(
        fakeExecutable,
        `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`,
        "utf8",
      );
    }
    await chmod(fakeExecutable, 0o755);
    pinnedRipgrep.path = fakeExecutable;
    workspaceMutationCoordinators.getOrCreate(root).acquire({
      workspaceRoot: root,
      editorInstanceId: "grep-subdir-confinement-editor",
    });
    const tool = bindExplicitDangerBoundary(
      createGrepTool({ allowedPaths: [root] }),
    );

    const result = await tool.execute({
      pattern: "needle",
      path: scoped,
      output_mode: "files_with_matches",
      head_limit: 0,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the requested search root");
    expect(result.content).not.toContain("sibling secret needle");
    expect(result.content).not.toContain("sibling/secret.txt");
  });
});
