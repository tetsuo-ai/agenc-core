import { describe, expect, it } from "vitest";

import { isRuntimeVerifierRequiredForTurn } from "./runtime-verifier-requirement.js";

describe("isRuntimeVerifierRequiredForTurn", () => {
  it("returns true only for workflow implementation turns with target artifacts", () => {
    expect(
      isRuntimeVerifierRequiredForTurn({
        flags: { verifierRuntimeRequired: true },
        turnExecutionContract: {
          turnClass: "workflow_implementation",
          targetArtifacts: ["/workspace/src/main.c"],
        },
      }),
    ).toBe(true);
  });

  it("returns false for dialogue turns even when the runtime flag is enabled", () => {
    expect(
      isRuntimeVerifierRequiredForTurn({
        flags: { verifierRuntimeRequired: true },
        turnExecutionContract: {
          turnClass: "dialogue",
          targetArtifacts: ["/workspace/src/main.c"],
        },
      }),
    ).toBe(false);
  });

  it("returns false when no target artifacts were declared", () => {
    expect(
      isRuntimeVerifierRequiredForTurn({
        flags: { verifierRuntimeRequired: true },
        turnExecutionContract: {
          turnClass: "workflow_implementation",
          targetArtifacts: [],
        },
      }),
    ).toBe(false);
  });
});
