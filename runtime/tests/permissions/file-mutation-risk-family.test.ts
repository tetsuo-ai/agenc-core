import { describe, expect, it } from "vitest";
import {
  FILE_MUTATION_TOOL_FAMILY,
  toolNamesInPermissionRiskFamily,
} from "../../src/permissions/rules.js";
import { normalizeUnattendedToolList } from "../../src/permissions/unattended-policy.js";

describe("file mutation permission risk family (TOOL-05)", () => {
  it("Edit risk family includes MultiEdit and apply_patch", () => {
    expect(FILE_MUTATION_TOOL_FAMILY).toContain("MultiEdit");
    expect(FILE_MUTATION_TOOL_FAMILY).toContain("apply_patch");
    expect(toolNamesInPermissionRiskFamily("Edit")).toEqual(
      expect.arrayContaining(["MultiEdit", "apply_patch", "Write"]),
    );
    expect(toolNamesInPermissionRiskFamily("MultiEdit")).toContain("Edit");
    expect(toolNamesInPermissionRiskFamily("apply_patch")).toContain("Write");
  });

  it("unattended denylist Edit covers MultiEdit and apply_patch", () => {
    const list = normalizeUnattendedToolList([
      "Edit",
      "MultiEdit",
      "apply_patch",
    ]);
    expect(list).toEqual(["Edit"]);
  });
});
