import { describe, expect, it } from "vitest";

import { runSafetySuite } from "./safety-suite.js";

describe("safety suite", () => {
  it("blocks prompt injection, hostile skill metadata, unsafe shell, marketplace attacks, and unauthorized writes", async () => {
    const artifact = await runSafetySuite();
    expect(artifact.scenarioCount).toBe(6);
    expect(artifact.passRate).toBe(1);
    expect(artifact.promptInjectionBlocks).toBe(1);
    expect(artifact.maliciousSkillMetadataBlocks).toBe(1);
    expect(artifact.marketplaceTaskPayloadBlocks).toBe(1);
    expect(artifact.unsafeShellBlocks).toBe(1);
    expect(artifact.unauthorizedArtifactWriteBlocks).toBe(1);
    expect(artifact.approvalCorrectnessRate).toBe(1);
  });
});
