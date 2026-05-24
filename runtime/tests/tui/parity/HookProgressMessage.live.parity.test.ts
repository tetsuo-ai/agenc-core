import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { sourcePath } from "../../helpers/source-path.ts";

const HOOK_PROGRESS_SOURCE = sourcePath("tui/message-renderers/HookProgressMessage.tsx");

function readSource(): string {
  return fs.readFileSync(HOOK_PROGRESS_SOURCE, "utf8");
}

describe("HookProgressMessage live rendering", () => {
  test("PreToolUse and PostToolUse hooks render progress outside transcript mode", () => {
    const source = readSource();
    const branchStart = source.indexOf(
      "if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse')",
    );
    expect(branchStart).toBeGreaterThanOrEqual(0);
    const branchEnd = source.indexOf("const resolvedHookCount", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);

    expect(branch).toContain("isTranscriptMode");
    expect(branch).toContain("<MessageResponse>");
    expect(branch).toContain("<HookProgressRow");
    expect(source).toContain("<Text dimColor={true}>Running </Text>");
    expect(branch).not.toMatch(/return\s+null\s*;/);
  });
});
