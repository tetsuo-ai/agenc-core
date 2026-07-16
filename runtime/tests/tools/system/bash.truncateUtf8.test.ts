import { describe, expect, test } from "vitest";
import { createBashTool as createUnboundBashTool } from "./bash.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

const createBashTool = (
  config?: Parameters<typeof createUnboundBashTool>[0],
) => bindExplicitDangerBoundary(createUnboundBashTool(config));

describe("bash truncate() UTF-8 boundary safety", () => {
  test("truncation at a multi-byte boundary does not emit U+FFFD", async () => {
    // Each '🚀' (U+1F680) is 4 bytes in UTF-8. Emit enough copies to exceed
    // the configured cap, with the cap deliberately set so the byte limit
    // lands in the middle of a multi-byte sequence rather than on a boundary.
    // A raw byte-offset slice would split a sequence and decode to U+FFFD;
    // a codepoint-aware truncate must back off to the prior boundary.
    const tool = createBashTool({
      cwd: process.cwd(),
      // 50 bytes -> not a multiple of 4, so it falls mid-emoji.
      maxOutputBytes: 50,
    });
    const result = await tool.execute({
      command: "printf '\\xF0\\x9F\\x9A\\x80%.0s' {1..40}",
    });
    expect(result.isError).toBeFalsy();
    // The whole point of the fix: no replacement character at the cut.
    expect(result.content.includes("�")).toBe(false);
    // It must actually have truncated (output far exceeds the cap).
    expect(result.content).toMatch(/\[truncated\]/);
    // Every emoji that survived must be intact (4 well-formed bytes).
    const body = result.content.replace(/\n?\[truncated\]\s*$/u, "");
    for (const ch of body) {
      // Surviving non-newline chars should only be the rocket emoji.
      if (ch !== "\n") expect(ch).toBe("🚀");
    }
  });

  test("cap exactly on a codepoint boundary keeps content clean", async () => {
    const tool = createBashTool({
      cwd: process.cwd(),
      // 48 bytes == 12 whole emojis: cut lands exactly on a boundary.
      maxOutputBytes: 48,
    });
    const result = await tool.execute({
      command: "printf '\\xF0\\x9F\\x9A\\x80%.0s' {1..40}",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.includes("�")).toBe(false);
    expect(result.content).toMatch(/\[truncated\]/);
  });
});
