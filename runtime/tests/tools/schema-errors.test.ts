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

    test("keeps the object message for an object, word for word", () => {
      expect(
        getSchemaValidationErrorOverride(ExecTool, {
          cmd: "npm start",
          sandbox_permissions: { network: "full" },
        }),
      ).toBe(
        'sandbox_permissions must be the plain string "default", "require_escalated" or ' +
          '"with_additional_permissions", not an object. Scoped permissions belong in ' +
          'additional_permissions alongside "with_additional_permissions", for example ' +
          '{"network":{"enabled":true}}. The command was not run.',
      );
    });

    // lt30 C-r1 (2026-11-06): the model already sent a plain string, so
    // "not an object" gave it nothing to fix and it repeated the call.
    test("names a rejected string and the accepted values, without calling it an object", () => {
      expect(
        getSchemaValidationErrorOverride(ExecTool, { cmd: "ls", sandbox_permissions: "full" }),
      ).toBe(
        'sandbox_permissions must be "default", "require_escalated" or ' +
          '"with_additional_permissions", not "full". Leave it out or send "default" to run ' +
          'in the sandbox; "require_escalated" asks to run outside it; ' +
          '"with_additional_permissions" asks for the scopes in additional_permissions. ' +
          "The command was not run.",
      );
    });

    test.each([
      [["network"], '["network"]'],
      [true, "true"],
      [3, "3"],
    ])("names the non-string value %j", (value, shown) => {
      const message = getSchemaValidationErrorOverride(ExecTool, {
        cmd: "ls",
        sandbox_permissions: value,
      });
      expect(message).toContain(`not ${shown}.`);
      expect(message).not.toContain("not an object");
    });

    test("shortens a long rejected value", () => {
      const message = getSchemaValidationErrorOverride(ExecTool, {
        cmd: "ls",
        sandbox_permissions: "x".repeat(200),
      })!;
      expect(message).toContain(`not "${"x".repeat(76)}...`);
      expect(message.length).toBeLessThan(400);
    });

    test("leaves a default-meaning spelling to the model-input fold", () => {
      for (const value of ["use_default", "none", "", null, "Default", " USE-DEFAULT "]) {
        expect(
          getSchemaValidationErrorOverride(ExecTool, { cmd: "ls", sandbox_permissions: value }),
        ).toBe(null);
      }
    });

    test("write_stdin gets the same override, with what happened to the input", () => {
      const WriteStdinTool = { name: "write_stdin" } as Tool;
      expect(
        getSchemaValidationErrorOverride(WriteStdinTool, {
          session_id: 3,
          chars: "y\n",
          sandbox_permissions: "escalated",
        }),
      ).toBe(
        'sandbox_permissions must be "default", "require_escalated" or ' +
          '"with_additional_permissions", not "escalated". For input, send the value the ' +
          "session was started with; an empty poll needs none. Nothing was sent to the session.",
      );
      expect(
        getSchemaValidationErrorOverride(WriteStdinTool, {
          session_id: 3,
          sandbox_permissions: { network: true },
        }),
      ).toContain("not an object. For input, send the value the session was started with");
      expect(
        getSchemaValidationErrorOverride(WriteStdinTool, {
          session_id: 3,
          sandbox_permissions: "require_escalated",
        }),
      ).toBe(null);
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
