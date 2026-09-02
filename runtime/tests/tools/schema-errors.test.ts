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

  // The live incident's model sent sandbox_permissions:{"network":"full"}
  // twelve times; the default enum prose never told it what to send instead.
  describe("exec_command sandbox_permissions", () => {
    const ExecTool = { name: "exec_command" } as Tool;

    test("names the accepted values and where scoped permissions go", () => {
      const message = getSchemaValidationErrorOverride(ExecTool, {
        cmd: "npm start",
        sandbox_permissions: { network: "full" },
      });
      expect(message).toContain('"require_escalated"');
      expect(message).toContain("not an object");
      expect(message).toContain("additional_permissions");
      expect(message).toContain("The command was not run.");
    });

    test("stays quiet for the documented values and when the field is absent", () => {
      for (const value of ["default", "require_escalated", "with_additional_permissions"]) {
        expect(
          getSchemaValidationErrorOverride(ExecTool, { cmd: "ls", sandbox_permissions: value }),
        ).toBe(null);
      }
      expect(getSchemaValidationErrorOverride(ExecTool, { cmd: "ls" })).toBe(null);
    });

    test("does not claim another tool's field", () => {
      expect(
        getSchemaValidationErrorOverride({ name: "Read" } as never, {
          sandbox_permissions: { network: "full" },
        }),
      ).toBe(null);
    });
  });
});
