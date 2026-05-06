import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_FIRST_RUN_SEEN_LIMIT,
  incrementFirstRunOnboardingSeenCount,
  incrementProjectOnboardingSeenCount,
  maybeMarkProjectOnboardingComplete,
  markFirstRunOnboardingComplete,
  readOnboardingState,
  shouldShowFirstRunOnboarding,
  shouldShowProjectOnboarding,
} from "./projectOnboardingState.js";

function withTempDir<T>(prefix: string, run: (path: string) => T): T {
  const path = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

describe("first-run onboarding display state", () => {
  test("requires an explicit interactive session", () => {
    withTempDir("agenc-onboarding-state-", (agencHome) => {
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
        }),
      ).toBe(false);
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: false,
        }),
      ).toBe(false);
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: true,
        }),
      ).toBe(true);
    });
  });

  test("persists seen counts and completion", () => {
    withTempDir("agenc-onboarding-state-", (agencHome) => {
      incrementFirstRunOnboardingSeenCount({ agencHome });
      expect(readOnboardingState({ agencHome }).seenCount).toBe(1);

      markFirstRunOnboardingComplete({
        agencHome,
        selectedProvider: "grok",
        selectedModel: "grok-4-fast",
        selectedTheme: "dark",
        completedStepIds: ["preflight", "theme"],
        now: new Date("2026-01-03T00:00:00.000Z"),
      });

      expect(readOnboardingState({ agencHome })).toMatchObject({
        completed: true,
        completedAt: "2026-01-03T00:00:00.000Z",
        selectedProvider: "grok",
        selectedModel: "grok-4-fast",
        selectedTheme: "dark",
        completedStepIds: ["preflight", "theme"],
      });
      expect(
        shouldShowFirstRunOnboarding({
          agencHome,
          env: {},
          isInteractive: true,
        }),
      ).toBe(false);
    });
  });

  test("normalizes malformed persisted state", () => {
    withTempDir("agenc-onboarding-state-", (agencHome) => {
      const projectRoot = resolve(join(agencHome, "project"));
      writeFileSync(
        join(agencHome, "onboarding.json"),
        `${JSON.stringify({
          completed: "yes",
          seenCount: -2.7,
          selectedProvider: " grok ",
          completedStepIds: ["preflight", 3, "security"],
          projects: {
            [projectRoot]: {
              hasCompletedProjectOnboarding: true,
              projectOnboardingSeenCount: 2.9,
              completedAt: " 2026-01-04T00:00:00.000Z ",
            },
            malformed: "not-an-object",
          },
        })}\n`,
      );

      const state = readOnboardingState({ agencHome });

      expect(state.completed).toBe(false);
      expect(state.seenCount).toBe(0);
      expect(state.selectedProvider).toBe("grok");
      expect(state.completedStepIds).toEqual(["preflight", "security"]);
      expect(state.projects[projectRoot]).toMatchObject({
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 2,
        completedAt: "2026-01-04T00:00:00.000Z",
      });
      expect(state.projects.malformed).toBeUndefined();
    });
  });
});

describe("project onboarding state machine", () => {
  test("shows until the per-project seen limit is reached", () => {
    withTempDir("agenc-project-state-", (agencHome) => {
      withTempDir("agenc-project-", (cwd) => {
        expect(
          shouldShowProjectOnboarding({
            agencHome,
            cwd,
            env: {},
          }),
        ).toBe(true);

        for (let i = 0; i < DEFAULT_FIRST_RUN_SEEN_LIMIT; i += 1) {
          incrementProjectOnboardingSeenCount({ agencHome, cwd });
        }

        expect(
          shouldShowProjectOnboarding({
            agencHome,
            cwd,
            env: {},
          }),
        ).toBe(false);
      });
    });
  });

  test("suppresses in demo mode", () => {
    withTempDir("agenc-project-state-", (agencHome) => {
      withTempDir("agenc-project-", (cwd) => {
        expect(
          shouldShowProjectOnboarding({
            agencHome,
            cwd,
            env: { AGENC_DEMO: "true" },
          }),
        ).toBe(false);
      });
    });
  });

  test("marks only the requested project complete when steps are complete", () => {
    withTempDir("agenc-project-state-", (agencHome) => {
      withTempDir("agenc-project-a-", (completeCwd) => {
        withTempDir("agenc-project-b-", (incompleteCwd) => {
          writeFileSync(join(completeCwd, "AGENC.md"), "Project rules.\n");

          maybeMarkProjectOnboardingComplete({
            agencHome,
            cwd: completeCwd,
            now: new Date("2026-01-05T00:00:00.000Z"),
          });
          maybeMarkProjectOnboardingComplete({
            agencHome,
            cwd: incompleteCwd,
            now: new Date("2026-01-06T00:00:00.000Z"),
          });

          const state = readOnboardingState({ agencHome });
          expect(state.projects[resolve(completeCwd)]).toMatchObject({
            hasCompletedProjectOnboarding: true,
            completedAt: "2026-01-05T00:00:00.000Z",
          });
          expect(state.projects[resolve(incompleteCwd)]).toBeUndefined();
        });
      });
    });
  });
});
