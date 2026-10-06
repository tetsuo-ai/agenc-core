import { describe, expect, test } from "vitest";
import { checkToolPathPermission } from "../../src/permissions/path-validation.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

describe("existing protected roots retain their safety floor", () => {
  test.each(["acceptEdits", "auto", "bypassPermissions"] as const)(
    ".agents stays non-automatic under %s", (mode) => {
      const path = "/private/tmp/synthetic-permission-root/.agents/skills/review/SKILL.md";
      const result = checkToolPathPermission({
        toolName: "Write", input: { file_path: path }, path,
        cwd: "/private/tmp/synthetic-permission-root",
        context: createEmptyToolPermissionContext({ mode }), operationType: "write",
      });
      expect(result.behavior).not.toBe("allow");
      expect(result.decisionReason).toMatchObject({
        type: "safetyCheck", classifierApprovable: false,
      });
    },
  );

  test.each([".git/config", ".agenc/config.toml"])(
    "%s keeps its explicit-user-only safety decision", (relative) => {
      const path = "/private/tmp/synthetic-permission-root/" + relative;
      const result = checkToolPathPermission({
        toolName: "Edit", input: { file_path: path }, path,
        cwd: "/private/tmp/synthetic-permission-root",
        context: createEmptyToolPermissionContext({ mode: "auto" }), operationType: "write",
      });
      expect(result.behavior).toBe("ask");
      expect(result.decisionReason).toMatchObject({
        type: "safetyCheck", classifierApprovable: false,
      });
    },
  );
});
