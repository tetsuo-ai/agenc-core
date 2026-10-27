import { describe, expect, test } from "vitest";

import { maxDecision, parseDecision } from "../../../src/sandbox/execpolicy/decision.js";
import { ExecPolicyError } from "../../../src/sandbox/execpolicy/error.js";

describe("parseDecision", () => {
  test.each(["allow", "prompt", "forbidden"] as const)("accepts %s", (decision) => {
    expect(parseDecision(decision)).toBe(decision);
  });

  test.each(["Allow", "deny", "forbidden ", ""])("refuses %j", (raw) => {
    expect(() => parseDecision(raw)).toThrow(ExecPolicyError);
    try {
      parseDecision(raw);
    } catch (error) {
      expect(error).toMatchObject({
        name: "ExecPolicyError",
        kind: "invalid_decision",
        message: `invalid decision: ${raw}`,
      });
    }
  });
});

describe("maxDecision", () => {
  test("empty input is no decision", () => {
    expect(maxDecision([])).toBeNull();
  });

  test("merges allow < prompt < forbidden", () => {
    expect(maxDecision(["allow"])).toBe("allow");
    expect(maxDecision(["allow", "prompt"])).toBe("prompt");
    expect(maxDecision(["prompt", "allow"])).toBe("prompt");
    expect(maxDecision(["allow", "forbidden", "prompt"])).toBe("forbidden");
    expect(maxDecision(["forbidden"])).toBe("forbidden");
  });
});
