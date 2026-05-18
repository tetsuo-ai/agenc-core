import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const HOOK_PROGRESS_SOURCE = path.resolve(
  import.meta.dirname,
  "../message-renderers/HookProgressMessage.tsx",
);

function readSource(): string {
  return fs.readFileSync(HOOK_PROGRESS_SOURCE, "utf8");
}

describe("HookProgressMessage live rendering", () => {
  test("PreToolUse and PostToolUse hooks render progress outside transcript mode", () => {
    const source = readSource();
    const branchStart = source.indexOf(
      'if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse")',
    );
    expect(branchStart).toBeGreaterThanOrEqual(0);
    const branchEnd = source.indexOf("if (resolvedHookCount === inProgressHookCount)", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);

    expect(branch).toContain("isTranscriptMode");
    expect(branch).toContain("<MessageResponse>");
    expect(branch).toContain("Running ");
    expect(branch).not.toMatch(/return\s+null\s*;/);
  });
});
