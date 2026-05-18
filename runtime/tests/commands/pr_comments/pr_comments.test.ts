// @ts-nocheck — pr_comments/index.ts has no .ts-nocheck pragma but pulls in
// commands.ts via createMovedToPluginCommand.ts which is.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const originalUserType = process.env.USER_TYPE;
afterEach(() => {
  if (originalUserType === undefined) delete process.env.USER_TYPE;
  else process.env.USER_TYPE = originalUserType;
});

const prComments = (await import("./index.js")).default;

describe("pr-comments command", () => {
  it("declares prompt-type metadata with the right name", () => {
    expect(prComments.type).toBe("prompt");
    expect(prComments.name).toBe("pr-comments");
    expect(prComments.description).toContain("comments from a GitHub pull request");
  });

  it("getPromptForCommand returns the gh-CLI driven prompt for non-ant users", async () => {
    delete process.env.USER_TYPE;
    const blocks = await prComments.getPromptForCommand!("", {} as never);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("gh pr view");
    expect(text).toContain("gh api");
    expect(text).toContain("PR-level comments");
    expect(text).toContain("review comments");
    expect(text).toContain("## Comments");
  });
});
