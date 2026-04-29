import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildShellResumeKey } from "./shell.js";

describe("shell", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("derives a stable resume key from workspace root and profile", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-shell-key-"));
    mkdirSync(join(workspace, "subdir"), { recursive: true });
    workspaces.push(workspace);

    expect(
      buildShellResumeKey({ workspaceRoot: workspace, profile: "coding" }),
    ).toBe(
      buildShellResumeKey({
        workspaceRoot: join(workspace, "subdir", ".."),
        profile: "coding",
      }),
    );
    expect(
      buildShellResumeKey({ workspaceRoot: workspace, profile: "coding" }),
    ).not.toBe(
      buildShellResumeKey({ workspaceRoot: workspace, profile: "research" }),
    );
  });
});
