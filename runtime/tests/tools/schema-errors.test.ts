import { describe, expect, test } from "vitest";

import { getSchemaValidationErrorOverride } from "./schema-errors.js";
import type { Tool } from "./types.js";

const SkillTool = { name: "Skill" } as Tool;

describe("getSchemaValidationErrorOverride", () => {
  test("returns actionable missing-skill error for Skill tool", () => {
    expect(getSchemaValidationErrorOverride(SkillTool, {})).toBe(
      'Missing skill name. Pass the skill name as the skill parameter (e.g., skill: "commit" or skill: "review-pr").',
    );
  });

  test("does not override unrelated tool schema failures", () => {
    expect(
      getSchemaValidationErrorOverride({ name: "Read" } as never, {}),
    ).toBe(null);
  });

  test("does not override Skill tool when skill is present", () => {
    expect(
      getSchemaValidationErrorOverride(SkillTool, { skill: "commit" }),
    ).toBe(null);
  });
});
