import { describe, expect, it } from "vitest";
import { readableToolError } from "../../src/utils/readable-tool-error.js";

describe("readableToolError", () => {
  it("preserves bracketed sandbox diagnostics directly and inside envelopes", () => {
    const reason = "[sandbox_policy_unexpressible] required sandbox cannot express the tool policy without bubblewrap; run agenc doctor";
    expect(readableToolError(reason)).toBe(reason);
    expect(readableToolError(JSON.stringify({ is_error: true, content: reason }))).toBe(reason);
  });

  it("continues to decode JSON arrays and hide malformed envelopes", () => {
    expect(readableToolError('[{"type":"text","text":"Permission denied"}]')).toBe("Permission denied");
    expect(readableToolError('[{"content":"private')).toBe("Tool execution failed");
    expect(readableToolError('{"content":"private')).toBe("Tool execution failed");
    expect(readableToolError('["private')).toBe("Tool execution failed");
  });
});
