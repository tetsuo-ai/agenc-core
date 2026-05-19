import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const originalEnv = {
  AGENC_ENTRYPOINT: process.env.AGENC_ENTRYPOINT,
  AGENC_REPL: process.env.AGENC_REPL,
  AGENC_REPL_MODE: process.env.AGENC_REPL_MODE,
  AGENC_VERIFY_PLAN: process.env.AGENC_VERIFY_PLAN,
  USER_TYPE: process.env.USER_TYPE,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function projectPath(rel: string): string {
  return join(process.cwd(), rel);
}

describe("null-stub tool cleanup", () => {
  test("deleted null-stub tool modules stay absent", () => {
    for (const rel of [
      "src/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.ts",
      "src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts",
      "src/tools/REPLTool/REPLTool.ts",
      "src/tools/TungstenTool/TungstenTool.ts",
      "src/tools/TungstenTool/TungstenLiveMonitor.ts",
    ]) {
      expect(existsSync(projectPath(rel)), rel).toBe(false);
    }
  });

  test("tool registry source has no null-stub registrations", () => {
    const source = readFileSync(projectPath("src/tools.ts"), "utf8");

    expect(source).not.toContain("const REPLTool = null");
    expect(source).not.toContain("const SuggestBackgroundPRTool = null");
    expect(source).not.toContain("VerifyPlanExecutionTool/VerifyPlanExecutionTool.js");
    expect(source).not.toContain("SuggestBackgroundPRTool ?");
    expect(source).not.toContain("VerifyPlanExecutionTool ?");
    expect(source).not.toContain("REPLTool ?");
  });

  test("REPL mode remains disabled after removing the executable tool", () => {
    process.env.AGENC_REPL_MODE = "1";
    process.env.AGENC_ENTRYPOINT = "cli";
    process.env.USER_TYPE = "ant";
    const source = readFileSync(projectPath("src/tools/REPLTool/constants.ts"), "utf8");

    expect(source).toMatch(/isReplModeEnabled\(\): boolean \{\s*return false\s*\}/s);
    expect(source).not.toContain("AGENC_REPL_MODE");
  });

  test("verify-plan reminders do not request a deleted tool", () => {
    const text = readFileSync(projectPath("src/utils/messages.ts"), "utf8");

    expect(text).toContain("Please verify directly");
    expect(text).not.toContain("VerifyPlanExecution");
  });
});
