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

  it("detects the orchestrator's resolver-denial message", () => {
    expect(
      isPermissionDeniedToolResult(
        JSON.stringify({
          error:
            "Permission denied: exec_command was denied by this session's approval resolver. Do not retry the same call; choose a different approach or ask the user how to proceed.",
        }),
      ),
    ).toBe(true);
    // A default denial (no resolver at all) is not a user rejection.
    expect(
      isPermissionDeniedToolResult(
        "Not permitted: exec_command cannot run in this session because no approval resolver is available to allow it.",
      ),
    ).toBe(false);
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
