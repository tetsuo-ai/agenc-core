import { describe, expect, it } from "vitest";

// MACRO is replaced at build time but not in test mode. Bundled skills with
// `files` resolve their extraction directory (MACRO.VERSION) at registration,
// i.e. at module load of bundledSkills.ts — stub before the dynamic import.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: "99.0.0",
  DISPLAY_VERSION: "0.0.0-test",
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER:
    "report the issue at https://github.com/tetsuo-ai/agenc-core/issues",
  PACKAGE_URL: "@tetsuo-ai/agenc",
  NATIVE_PACKAGE_URL: undefined,
};

import type { Session } from "../session/session.js";

function stubSession(opts: {
  availableSkills?: ReadonlyArray<{ readonly name: string }>;
}): Session {
  return {
    config: { model: "test" },
    services: {
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: [],
          availableSkills: opts.availableSkills ?? [],
        }),
      },
      pluginsManager: {
        pluginsForConfig: async () => ({
          effectiveSkillRoots: () => [],
        }),
      },
    },
  } as unknown as Session;
}

describe("/skills bundled skill listing", () => {
  it("lists registered bundled skills with the bundled source tag", async () => {
    const { collectSkillsSnapshot, formatSkillsSnapshot } = await import(
      "./skills.js"
    );
    const snapshot = await collectSkillsSnapshot(stubSession({}));

    const names = snapshot.availableSkills.map((skill) => skill.name);
    expect(names).toContain("browser-automation");
    expect(names).toContain("agenc-marketplace-kit-installer");
    expect(
      snapshot.availableSkills.find(
        (skill) => skill.name === "browser-automation",
      )?.loadedFrom,
    ).toBe("bundled");

    const text = formatSkillsSnapshot(snapshot, { showAll: true });
    expect(text).toContain("$browser-automation");
    expect(text).toMatch(/\$browser-automation - .+ \[bundled\]/);
  });

  it("lets a local skill shadow a bundled skill with the same name", async () => {
    const { collectSkillsSnapshot } = await import("./skills.js");
    const snapshot = await collectSkillsSnapshot(
      stubSession({ availableSkills: [{ name: "browser-automation" }] }),
    );

    const matches = snapshot.availableSkills.filter(
      (skill) => skill.name === "browser-automation",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.loadedFrom).not.toBe("bundled");
  });
});
