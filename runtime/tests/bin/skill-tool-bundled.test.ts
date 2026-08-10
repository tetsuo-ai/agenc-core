import { describe, expect, it } from "vitest";

// Invoking a bundled skill extracts its reference files, which resolves the
// build-time MACRO define. Stub before the dynamic imports below.
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

function sessionWithoutLocalSkill(): Session {
  return {
    conversationId: "conv-test",
    config: {},
    services: {
      skillsManager: {
        // The local loader is typed to exclude the bundled source, so it
        // returns null for these — exactly as in production.
        renderSkill: async () => null,
        resolveSkill: async () => null,
        skillsForConfig: async () => ({
          invokedSkills: [],
          availableSkills: [{ name: "local-only" }],
        }),
      },
      configStore: { current: () => ({}) },
    },
  } as unknown as Session;
}

describe("Skill tool with runtime-registered bundled skills", () => {
  // Regression: exercised against a real ESP32-S3, the model saw $iot-builder,
  // called Skill(iot-builder) and got a hard `Unknown skill: iot-builder` for
  // a skill the runtime ships, lists in /skills, and answers to as
  // /iot-builder. It derailed the turn with an error instead of loading.
  it("loads a bundled skill the local loader cannot render", async () => {
    const { createModelFacingTools } = await import("./model-facing-tools.js");
    const session = sessionWithoutLocalSkill();
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const skill = tools.find((tool) => tool.name === "Skill")!;

    const result = await skill.execute({ skill: "iot-builder" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("<command-name>iot-builder</command-name>");
    expect(result.content).toContain("Identify the hardware");
  });

  it("still reports genuinely unknown names, listing bundled ones as available", async () => {
    const { createModelFacingTools } = await import("./model-facing-tools.js");
    const session = sessionWithoutLocalSkill();
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const skill = tools.find((tool) => tool.name === "Skill")!;

    const result = await skill.execute({ skill: "no-such-skill" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content) as {
      error: string;
      available: string[];
    };
    expect(payload.error).toContain("no-such-skill");
    expect(payload.available).toContain("iot-builder");
    expect(payload.available).toContain("browser-automation");
    expect(payload.available).toContain("local-only");
  });
});
