import { describe, expect, it } from "vitest";

// The Skill tool's bundled-skill fallback resolves the build-time MACRO
// define at registration. Stub before the dynamic imports below.
(globalThis as Record<string, unknown>).MACRO = {
  VERSION: "99.0.0",
  DISPLAY_VERSION: "0.0.0-test",
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER:
    "report the issue at https://github.com/tetsuo-ai/agenc-core/issues",
  PACKAGE_URL: "@tetsuo-ai/agenc",
  NATIVE_PACKAGE_URL: undefined,
};

import type { Session } from "../session/session.js";

interface Entry {
  readonly name: string;
  readonly description?: string;
  readonly disableModelInvocation?: boolean;
}

function sessionWith(availableSkills: readonly Entry[]): Session {
  return {
    conversationId: "conv-unknown-skill",
    config: {},
    services: {
      skillsManager: {
        renderSkill: async () => null,
        resolveSkill: async () => null,
        skillsForConfig: async () => ({ invokedSkills: [], availableSkills }),
      },
      configStore: { current: () => ({}) },
    },
  } as unknown as Session;
}

async function refusalFor(session: Session, name: string) {
  const { createModelFacingTools } = await import("./model-facing-tools.js");
  const skill = createModelFacingTools({
    workspaceRoot: process.cwd(),
    getSession: () => session,
  }).find((tool) => tool.name === "Skill")!;
  const result = await skill.execute({ skill: name });
  expect(result.isError).toBe(true);
  return {
    size: result.content.length,
    payload: JSON.parse(result.content) as {
      error: string;
      available: string[];
      availableCount?: number;
      note?: string;
    },
  };
}

/** A catalog the size of a shared one: 1,800 names, a few of them relevant. */
function largeCatalog(): Entry[] {
  const filler = Array.from({ length: 1_800 }, (_, i) => ({
    name: `vendor-${String(i).padStart(4, "0")}-integration-helper`,
    description: "Integration helper for a third-party vendor API",
  }));
  return [
    ...filler,
    { name: "pdf", description: "Read, write and merge PDF files" },
    { name: "pdf-generator", description: "Generate PDF documents" },
    { name: "report-generator", description: "Generate reports" },
    { name: "pdf-secret", description: "Private", disableModelInvocation: true },
  ];
}

describe("Skill tool unknown-name refusal", () => {
  it("names the closest skills instead of every installed one", async () => {
    const { size, payload } = await refusalFor(sessionWith(largeCatalog()), "pdf-report");
    expect(payload.error).toContain("pdf-report");
    expect(payload.available).toEqual(
      expect.arrayContaining(["pdf", "pdf-generator", "report-generator"]),
    );
    expect(payload.available).not.toContain("pdf-secret");
    expect(payload.available.length).toBeLessThanOrEqual(20);
    expect(payload.availableCount).toBeGreaterThanOrEqual(1_803);
    // Every installed name costs the model about 45 KB, 11,000 tokens,
    // for one mistyped name on the audited machine.
    expect(size).toBeLessThan(3_000);
  });

  it("says so when no installed name resembles the request", async () => {
    const { payload } = await refusalFor(sessionWith(largeCatalog()), "zzqx");
    expect(payload.available).toEqual([]);
    expect(payload.note).toMatch(/skill listing/u);
  });

  it("keeps the full list for a small catalog, without model-proof skills", async () => {
    const { payload } = await refusalFor(
      sessionWith([
        { name: "local-only" },
        { name: "hidden", disableModelInvocation: true },
      ]),
      "no-such-skill",
    );
    expect(payload.available).toContain("local-only");
    expect(payload.available).toContain("browser-automation");
    expect(payload.available).not.toContain("hidden");
    expect(payload.availableCount).toBeUndefined();
  });
});
