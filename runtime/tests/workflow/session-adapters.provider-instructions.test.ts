import { describe, expect, it } from "vitest";
import { workflowProviderInstructions } from "../../src/app-server/workflow/session-adapters.js";

describe("Goal provider fallback instructions", () => {
  it("discloses disabled cross-provider agents and continues on the selected model", () => {
    const prompt = workflowProviderInstructions(false);
    expect(prompt).toContain("If the goal asks for another provider's agents");
    expect(prompt).toContain("say in one line: 'Cross-provider agents are off; continuing on the selected model.'");
    expect(prompt).toContain("Then continue the goal on the selected model");
    expect(prompt).toContain("Do not enable providers, change settings, or claim those agents were used");
    expect(prompt).toContain("still verify every functional requirement");
  });

  it("does not announce a disabled feature when cross-provider agents are enabled", () => {
    expect(workflowProviderInstructions(true)).toBe("");
  });
});
