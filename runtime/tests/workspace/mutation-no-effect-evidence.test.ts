import { describe, expect, it } from "vitest";
import {
  describeWorkspaceMutationNoEffect,
  markWorkspaceMutationNoEffect,
  workspaceMutationNoEffectEvidence,
} from "../../src/workspace/file-mutation-transaction.js";

describe("workspace mutation no-effect evidence (#2500)", () => {
  it("rides on the rethrown error without becoming enumerable or changing its class", () => {
    const error = new RangeError("EACCES: permission denied");
    expect(markWorkspaceMutationNoEffect(error, "original_state_verified")).toBe(error);
    expect(error).toBeInstanceOf(RangeError);
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe("{}");
    expect(workspaceMutationNoEffectEvidence(error)).toBe("original_state_verified");
  });

  it("is absent on unmarked errors and on non-objects", () => {
    expect(workspaceMutationNoEffectEvidence(new Error("unknown"))).toBeUndefined();
    expect(workspaceMutationNoEffectEvidence("EACCES")).toBeUndefined();
    expect(workspaceMutationNoEffectEvidence(null)).toBeUndefined();
    expect(markWorkspaceMutationNoEffect("text", "pre_effect")).toBe("text");
  });

  it("describes each verdict for the model", () => {
    expect(describeWorkspaceMutationNoEffect("pre_effect")).toContain("No bytes were written");
    expect(describeWorkspaceMutationNoEffect("original_state_verified")).toContain("unchanged");
    expect(describeWorkspaceMutationNoEffect("rollback_verified")).toContain("restored");
  });
});
