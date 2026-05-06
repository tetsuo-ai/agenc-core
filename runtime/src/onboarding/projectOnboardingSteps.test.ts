import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  findProjectInstructionFilePathInAncestors,
  getSteps,
  isProjectOnboardingComplete,
} from "./projectOnboardingSteps.js";

function withTempDir<T>(prefix: string, run: (path: string) => T): T {
  const path = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

describe("project onboarding steps", () => {
  test("enables workspace creation for an empty directory", () => {
    withTempDir("agenc-project-steps-", (cwd) => {
      const steps = getSteps({ cwd });

      expect(steps).toEqual([
        {
          key: "workspace",
          text: "Ask AgenC to create a new app or clone a repository",
          isComplete: false,
          isCompletable: true,
          isEnabled: true,
        },
        {
          key: "agencmd",
          text: "Run agenc init to add AGENC.md project instructions",
          isComplete: false,
          isCompletable: true,
          isEnabled: false,
        },
      ]);
      expect(isProjectOnboardingComplete({ cwd })).toBe(false);
    });
  });

  test("requires AgenC instructions for a non-empty workspace", () => {
    withTempDir("agenc-project-steps-", (cwd) => {
      writeFileSync(join(cwd, "package.json"), "{}\n");

      const steps = getSteps({ cwd });

      expect(steps.find((step) => step.key === "workspace")?.isEnabled).toBe(false);
      expect(steps.find((step) => step.key === "agencmd")).toMatchObject({
        isComplete: false,
        isEnabled: true,
      });
      expect(isProjectOnboardingComplete({ cwd })).toBe(false);
    });
  });

  test("completes when AGENC.md exists in the workspace or an ancestor", () => {
    withTempDir("agenc-project-steps-", (cwd) => {
      const child = join(cwd, "app", "src");
      mkdirSync(child, { recursive: true });
      writeFileSync(join(cwd, "AGENC.md"), "Project rules.\n");
      writeFileSync(join(child, "index.ts"), "export {};\n");

      expect(findProjectInstructionFilePathInAncestors({ cwd: child })).toBe(
        join(cwd, "AGENC.md"),
      );
      expect(isProjectOnboardingComplete({ cwd: child })).toBe(true);
    });
  });

  test("does not treat an AGENC.md directory as project instructions", () => {
    withTempDir("agenc-project-steps-", (cwd) => {
      mkdirSync(join(cwd, "AGENC.md"));

      expect(findProjectInstructionFilePathInAncestors({ cwd })).toBeNull();
      expect(isProjectOnboardingComplete({ cwd })).toBe(false);
    });
  });
});
