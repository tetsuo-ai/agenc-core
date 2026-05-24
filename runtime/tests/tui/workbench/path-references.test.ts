import { describe, expect, it } from "vitest";

import {
  containsWorkspacePathReference,
  normalizeWorkspacePathForReferences,
  renameWorkspacePathReference,
} from "../../../src/tui/workbench/pathReferences.js";

describe("workbench path references", () => {
  it("canonicalizes separators and dot segments without trimming file names", () => {
    expect(normalizeWorkspacePathForReferences("")).toBe("");
    expect(normalizeWorkspacePathForReferences("./src//nested/../app.ts/")).toBe("src/app.ts");
    expect(normalizeWorkspacePathForReferences("src\\nested\\app.ts")).toBe("src/nested/app.ts");
    expect(normalizeWorkspacePathForReferences(" leading.ts ")).toBe(" leading.ts ");
  });

  it("renames exact and descendant references without touching empty or sibling paths", () => {
    expect(renameWorkspacePathReference(null, "src", "lib")).toBeNull();
    expect(renameWorkspacePathReference("src/app.ts", "", "lib")).toBe("src/app.ts");
    expect(renameWorkspacePathReference("src", "src", "lib")).toBe("lib");
    expect(renameWorkspacePathReference("./src//nested/app.ts", "src", "lib")).toBe("lib/nested/app.ts");
    expect(renameWorkspacePathReference("src-old/app.ts", "src", "lib")).toBe("src-old/app.ts");
  });

  it("detects exact and descendant references without matching empty or sibling paths", () => {
    expect(containsWorkspacePathReference(null, "src")).toBe(false);
    expect(containsWorkspacePathReference("src/app.ts", "")).toBe(false);
    expect(containsWorkspacePathReference("./src//nested/app.ts", "src")).toBe(true);
    expect(containsWorkspacePathReference("src", "src")).toBe(true);
    expect(containsWorkspacePathReference("src-old/app.ts", "src")).toBe(false);
  });
});
