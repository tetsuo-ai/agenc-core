// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

vi.mock("../utils/attribution.js", () => ({
  getAttributionTexts: () => ({ commit: "" }),
}));
vi.mock("../utils/undercover.js", () => ({
  getUndercoverInstructions: () => "[undercover instructions]",
  isUndercover: () => false,
}));

// executeShellCommandsInPrompt actually runs `git status`/`git diff` etc.
// against the host. Stub it to a deterministic substitution so the test
// asserts on the prompt-template shape, not on real git output.
vi.mock("../utils/promptShellExecution.js", () => ({
  executeShellCommandsInPrompt: vi.fn(
    async (template: string) => template.replace(/!`[^`]+`/g, "<git-output>"),
  ),
}));

const { executeShellCommandsInPrompt } = await import(
  "../utils/promptShellExecution.js"
);
const commitCommand = (await import("./commit.js")).default;

const originalUserType = process.env.USER_TYPE;
afterEach(() => {
  if (originalUserType === undefined) delete process.env.USER_TYPE;
  else process.env.USER_TYPE = originalUserType;
  vi.mocked(executeShellCommandsInPrompt).mockClear();
});

describe("commit command spec", () => {
  it("declares prompt-type metadata + allowed git tools", () => {
    expect(commitCommand.type).toBe("prompt");
    expect(commitCommand.name).toBe("commit");
    expect(commitCommand.description).toContain("git commit");
    expect(commitCommand.allowedTools).toEqual(
      expect.arrayContaining([
        "Bash(git add:*)",
        "Bash(git status:*)",
        "Bash(git commit:*)",
      ]),
    );
  });
});

describe("commit getPromptForCommand", () => {
  it("returns a single text block containing the git rubric", async () => {
    delete process.env.USER_TYPE;
    const ctx = {
      getAppState: () => ({
        toolPermissionContext: { alwaysAllowRules: { command: [] } },
      }),
    } as never;
    const blocks = await commitCommand.getPromptForCommand!("", ctx);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("Git Safety Protocol");
    expect(text).toContain("NEVER skip hooks");
    expect(text).toContain("NEVER update the git config");
    expect(text).toContain("create a single git commit");
    // Shell-execution placeholders were substituted by our mock.
    expect(text).toContain("<git-output>");
  });

  it("invokes the prompt-shell executor with /commit as the source label", async () => {
    delete process.env.USER_TYPE;
    const ctx = {
      getAppState: () => ({
        toolPermissionContext: { alwaysAllowRules: { command: [] } },
      }),
    } as never;
    await commitCommand.getPromptForCommand!("", ctx);
    expect(executeShellCommandsInPrompt).toHaveBeenCalled();
    const args = vi.mocked(executeShellCommandsInPrompt).mock.calls[0];
    expect(args?.[2]).toBe("/commit");
  });
});
