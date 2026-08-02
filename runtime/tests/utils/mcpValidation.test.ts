import { afterEach, describe, expect, test } from "vitest";

import {
  getContentSizeEstimate,
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from "./mcpValidation.js";
import type { MCPToolResult } from "./mcpValidation.js";

const originalLimit = process.env.MAX_MCP_OUTPUT_TOKENS;

afterEach(() => {
  if (originalLimit === undefined) {
    delete process.env.MAX_MCP_OUTPUT_TOKENS;
  } else {
    process.env.MAX_MCP_OUTPUT_TOKENS = originalLimit;
  }
});

describe("MCP accounting and truncation", () => {
  test("keeps bounded text and truncates oversized UTF-8 content", async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = "2000";
    const short = "small result";
    const long = "👩‍💻漢字".repeat(2_000);

    expect(getContentSizeEstimate(short)).toBeGreaterThan(0);
    await expect(mcpContentNeedsTruncation(short)).resolves.toBe(false);
    await expect(mcpContentNeedsTruncation(long)).resolves.toBe(true);

    const truncated = await truncateMcpContentIfNeeded(long);
    expect(typeof truncated).toBe("string");
    expect(truncated).toContain("[OUTPUT TRUNCATED");
    expect(getContentSizeEstimate(truncated)).toBeLessThanOrEqual(2_000);
    expect(truncated).not.toContain("\ufffd");
  });

  test("treats unknown provider blocks as uncertain and omits them", async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = "2000";
    const content = [
      { type: "text", text: "known" },
      { type: "opaque_provider_block", payload: "unknown" },
    ] as unknown as MCPToolResult;

    await expect(mcpContentNeedsTruncation(content)).resolves.toBe(true);
    const truncated = await truncateMcpContentIfNeeded(content);
    expect(truncated).toEqual([
      expect.objectContaining({ type: "text", text: "known" }),
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("[OUTPUT TRUNCATED"),
      }),
    ]);
  });

  test("rejects when even the bounded truncation notice cannot fit", async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = "1";

    await expect(truncateMcpContentIfNeeded("oversized")).resolves.toBeUndefined();
  });

  test("accounts inline images but fails closed for unbounded image sources", async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = "2000";
    const inline = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      },
    ] as MCPToolResult;
    const remote = [
      {
        type: "image",
        source: { type: "url", url: "https://media.example/image.png" },
      },
    ] as unknown as MCPToolResult;

    await expect(mcpContentNeedsTruncation(inline)).resolves.toBe(false);
    await expect(mcpContentNeedsTruncation(remote)).resolves.toBe(true);
    await expect(truncateMcpContentIfNeeded(remote)).resolves.toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("[OUTPUT TRUNCATED"),
      }),
    ]);
  });
});
