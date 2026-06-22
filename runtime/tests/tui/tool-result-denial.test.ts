import { describe, expect, it } from "vitest";

import {
  isPermissionDeniedToolResult,
  PERMISSION_DENIED_TOOL_RESULT_MESSAGE,
} from "./tool-result-denial.js";

describe("isPermissionDeniedToolResult", () => {
  it("detects direct denial text", () => {
    expect(isPermissionDeniedToolResult("rejected by user")).toBe(true);
    expect(isPermissionDeniedToolResult("  Rejected By User  ")).toBe(true);
  });

  it("detects nested denial text in records and arrays", () => {
    expect(
      isPermissionDeniedToolResult({
        content: [{ message: "rejected by user" }],
      }),
    ).toBe(true);
  });

  it("parses JSON strings recursively", () => {
    expect(
      isPermissionDeniedToolResult(
        JSON.stringify({ error: "rejected by user" }),
      ),
    ).toBe(true);
  });

  it("rejects non-denial values", () => {
    expect(isPermissionDeniedToolResult("permission granted")).toBe(false);
    expect(isPermissionDeniedToolResult({ error: "different failure" })).toBe(
      false,
    );
    expect(isPermissionDeniedToolResult(["not denied"])).toBe(false);
  });

  it("exposes the canonical denial message", () => {
    expect(PERMISSION_DENIED_TOOL_RESULT_MESSAGE).toBe(
      "Permission request denied by user.",
    );
  });
});
