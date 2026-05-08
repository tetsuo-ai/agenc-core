// @ts-nocheck — review.ts is itself ts-nocheck'd; the test mirrors that surface.
import { describe, expect, it, vi } from "vitest";

// review.ts → commands.ts → collapseReadSearch.ts uses bun:bundle's
// feature() to gate optional plugin tools at bundle time. In vitest the
// runtime require fails (the gated module is bundle-only). Stub feature
// to false so all gates collapse to the no-op branch.
vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
// commands.ts → tools.ts gated-requires modules that exist only after the
// tsup bundle resolves bun:bundle's feature() gates. Short-circuit the
// chain by stubbing tools.ts to an empty toolset. The review command
// doesn't read these tools — it only renders a prompt string.
vi.mock("../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const review = (await import("./review.js")).default;

describe("review command", () => {
  it("declares prompt-type metadata", () => {
    expect(review.type).toBe("prompt");
    expect(review.name).toBe("review");
    expect(review.description).toContain("Review a pull request");
  });

  it("getPromptForCommand returns a text block referencing the PR number", async () => {
    const blocks = await review.getPromptForCommand!("123", {} as never);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text" });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("PR number: 123");
    expect(text).toContain("gh pr view");
    expect(text).toContain("gh pr diff");
  });

  it("getPromptForCommand handles an empty args string", async () => {
    const blocks = await review.getPromptForCommand!("", {} as never);
    const text = (blocks[0] as { text: string }).text;
    // Empty arg passes through unchanged into the prompt — the model is
    // instructed to run `gh pr list` in that case.
    expect(text).toContain("gh pr list");
  });

  it("getPromptForCommand prompt includes the review framework rubric", async () => {
    const blocks = await review.getPromptForCommand!("42", {} as never);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("Code correctness");
    expect(text).toContain("Test coverage");
    expect(text).toContain("Security considerations");
  });
});
