import { describe, expect, test } from "vitest";
import {
  attemptWithRetry,
  classifyToolApproval,
  defaultRetryPolicy,
} from "./orchestrator.js";
import type { Tool } from "./types.js";

const readTool: Tool = {
  name: "system.readFile",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
  isReadOnly: true,
};

const writeTool: Tool = {
  name: "system.writeFile",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
  isReadOnly: false,
};

describe("classifyToolApproval", () => {
  test("approvalPolicy=never → skip (bypass sandbox only on danger_full_access)", () => {
    const skipReadOnly = classifyToolApproval(writeTool, {
      approvalPolicy: "never",
      sandboxMode: "read_only",
    });
    expect(skipReadOnly.kind).toBe("skip");

    const skipYolo = classifyToolApproval(writeTool, {
      approvalPolicy: "never",
      sandboxMode: "danger_full_access",
    });
    expect(skipYolo.kind).toBe("skip");
    if (skipYolo.kind === "skip") expect(skipYolo.bypassSandbox).toBe(true);
  });

  test("granular policy → read-only skip, write needs approval", () => {
    expect(
      classifyToolApproval(readTool, {
        approvalPolicy: "granular",
        sandboxMode: "read_only",
      }).kind,
    ).toBe("skip");
    expect(
      classifyToolApproval(writeTool, {
        approvalPolicy: "granular",
        sandboxMode: "read_only",
      }).kind,
    ).toBe("needs_approval");
  });

  test("denylist wins", () => {
    const res = classifyToolApproval(readTool, {
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      toolDenylist: new Set(["system.readFile"]),
    });
    expect(res.kind).toBe("forbidden");
  });

  test("untrusted policy always needs approval", () => {
    expect(
      classifyToolApproval(readTool, {
        approvalPolicy: "untrusted",
        sandboxMode: "workspace_write",
      }).kind,
    ).toBe("needs_approval");
  });
});

describe("defaultRetryPolicy + attemptWithRetry", () => {
  test("default policy bubbles every error", () => {
    expect(defaultRetryPolicy().kind).toBe("bubble");
  });

  test("retry decision re-dispatches up to maxAttempts", async () => {
    let attempts = 0;
    const result = await attemptWithRetry({
      dispatch: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return "ok";
      },
      onFailure: () => ({ kind: "retry", reason: "transient" }),
      maxAttempts: 3,
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("maxAttempts cap bubbles last error", async () => {
    await expect(
      attemptWithRetry({
        dispatch: async () => {
          throw new Error("perm");
        },
        onFailure: () => ({ kind: "retry", reason: "x" }),
        maxAttempts: 2,
      }),
    ).rejects.toThrow("perm");
  });
});
