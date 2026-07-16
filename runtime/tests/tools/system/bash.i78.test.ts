import { describe, expect, test } from "vitest";
import { createBashTool as createUnboundBashTool } from "./bash.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

const createBashTool = (
  config?: Parameters<typeof createUnboundBashTool>[0],
) => bindExplicitDangerBoundary(createUnboundBashTool(config));

describe("I-78 bash Buffer chunk accumulation", () => {
  test("multi-byte UTF-8 emoji split across chunks decodes intact", async () => {
    // Use bash's printf to emit a 4-byte emoji that would otherwise
    // split across process stdio chunks on some runtimes.
    const tool = createBashTool({ cwd: process.cwd() });
    const result = await tool.execute({
      command: 'printf "pre\\xF0\\x9F\\x9A\\x80post"',
    });
    expect(result.isError).toBeFalsy();
    // The decoded output must contain the full emoji U+1F680 ('🚀').
    expect(result.content).toMatch(/pre🚀post/u);
  });

  test("large stdout output accumulates intact (decodes once at flush)", async () => {
    const tool = createBashTool({ cwd: process.cwd() });
    const result = await tool.execute({
      command: "printf 'xxxxxxxxxx%.0s' {1..300}",
    });
    expect(result.isError).toBeFalsy();
    // I-78 assertion: output body is ASCII 'x' only — no replacement
    // characters from UTF-8 decode corruption.
    expect(result.content.includes("\uFFFD")).toBe(false);
    const xCount = (result.content.match(/x/g) ?? []).length;
    expect(xCount).toBeGreaterThan(100);
  });
});
