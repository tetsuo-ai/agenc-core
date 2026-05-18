import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const dialogSources = [
  "MCPServerApprovalDialog.tsx",
  "MCPServerDesktopImportDialog.tsx",
  "MCPServerMultiselectDialog.tsx",
].map((file) => ({
  file,
  source: readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
}));

describe("MCP server dialog migration cleanup", () => {
  test.each(dialogSources)("$file has no moved-source or ts-nocheck scaffolding", ({ source }) => {
    expect(source).not.toContain("@ts-nocheck");
    expect(source).not.toContain("Moved-source note");
  });

  test("single-server approval uses the current settings reader and AgenC analytics name", () => {
    const approval = dialogSources.find(({ file }) => file === "MCPServerApprovalDialog.tsx");

    expect(approval?.source).not.toContain("getSettings_DEPRECATED");
    expect(approval?.source).not.toContain("tengu_mcp_dialog_choice");
    expect(approval?.source).toContain("getInitialSettings");
    expect(approval?.source).toContain("agenc_mcp_dialog_choice");
  });
});
