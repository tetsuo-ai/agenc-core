/**
 * Phase G acceptance test: the ToolPermissionEvaluator's new
 * `approvalRequester` callback resolves "ask" decisions
 * synchronously when supplied, mirroring the WebSocket approval
 * flow the gateway would wire into it. Bubbles the "ask" through
 * unchanged when the requester is not supplied (legacy path).
 */

import { describe, expect, it, vi } from "vitest";
import { ToolPermissionEvaluator, type ToolRule } from "./tool-permission-evaluator.js";
import type { LLMToolCall } from "../llm/types.js";

function makeToolCall(
  name = "system.writeFile",
  args: Record<string, unknown> = { path: "/tmp/x" },
): LLMToolCall {
  return {
    id: `call-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: JSON.stringify(args),
  };
}

describe("ToolPermissionEvaluator — approvalRequester (Phase G)", () => {
  const askRule: ToolRule = {
    pattern: "system.writeFile",
    effect: "ask",
    message: "Requires approval to write files",
  };

  it("returns ask unchanged when no approvalRequester is supplied", async () => {
    const evaluator = new ToolPermissionEvaluator({
      rules: [askRule],
    });
    const result = await evaluator.evaluate(makeToolCall(), {
      sessionId: "s1",
    });
    expect(result.behavior).toBe("ask");
    if (result.behavior === "ask") {
      expect(result.message).toBe("Requires approval to write files");
    }
  });

  it("resolves the ask through approvalRequester and returns the resolved allow", async () => {
    const requester = vi.fn(async () => ({
      behavior: "allow" as const,
    }));
    const evaluator = new ToolPermissionEvaluator({
      rules: [askRule],
      approvalRequester: requester,
    });
    const result = await evaluator.evaluate(makeToolCall(), {
      sessionId: "s1",
    });
    expect(requester).toHaveBeenCalledTimes(1);
    expect(result.behavior).toBe("allow");
  });

  it("resolves the ask through approvalRequester and returns the resolved deny", async () => {
    const requester = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "operator rejected the request",
    }));
    const evaluator = new ToolPermissionEvaluator({
      rules: [askRule],
      approvalRequester: requester,
    });
    const result = await evaluator.evaluate(makeToolCall(), {
      sessionId: "s1",
    });
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe("operator rejected the request");
    }
  });

  it("passes the rule's approvalConfig through to the requester", async () => {
    const askWithConfig: ToolRule = {
      ...askRule,
      approvalConfig: {
        slaMs: 30_000,
        approverGroup: "security-team",
        approverRoles: ["approver", "lead"],
      },
    };
    const requester = vi.fn(async () => ({ behavior: "allow" as const }));
    const evaluator = new ToolPermissionEvaluator({
      rules: [askWithConfig],
      approvalRequester: requester,
    });
    await evaluator.evaluate(makeToolCall(), { sessionId: "s1" });
    expect(requester).toHaveBeenCalledTimes(1);
    const [, , askArg] = requester.mock.calls[0] ?? [];
    expect(askArg?.approvalConfig).toEqual({
      slaMs: 30_000,
      approverGroup: "security-team",
      approverRoles: ["approver", "lead"],
    });
  });

  it("does not invoke the requester when a deny rule matches earlier", async () => {
    const denyRule: ToolRule = {
      pattern: "system.writeFile",
      effect: "deny",
      message: "hard denied",
    };
    const requester = vi.fn(async () => ({ behavior: "allow" as const }));
    const evaluator = new ToolPermissionEvaluator({
      rules: [denyRule, askRule],
      approvalRequester: requester,
    });
    const result = await evaluator.evaluate(makeToolCall(), {
      sessionId: "s1",
    });
    expect(result.behavior).toBe("deny");
    expect(requester).not.toHaveBeenCalled();
  });

  it("does not invoke the requester when an allow rule matches alongside the ask", async () => {
    const allowRule: ToolRule = {
      pattern: "system.writeFile",
      effect: "allow",
    };
    const requester = vi.fn(async () => ({ behavior: "allow" as const }));
    const evaluator = new ToolPermissionEvaluator({
      rules: [allowRule, askRule],
      approvalRequester: requester,
    });
    const result = await evaluator.evaluate(makeToolCall(), {
      sessionId: "s1",
    });
    expect(result.behavior).toBe("allow");
    expect(requester).not.toHaveBeenCalled();
  });

  it("does not invoke the requester for tool calls that do not match the ask pattern", async () => {
    const requester = vi.fn(async () => ({ behavior: "allow" as const }));
    const evaluator = new ToolPermissionEvaluator({
      rules: [askRule],
      approvalRequester: requester,
    });
    const result = await evaluator.evaluate(
      makeToolCall("system.readFile"),
      { sessionId: "s1" },
    );
    expect(result.behavior).toBe("allow");
    expect(requester).not.toHaveBeenCalled();
  });
});
