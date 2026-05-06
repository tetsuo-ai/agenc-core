import { describe, expect, test } from "vitest";

import type { ToolInvocation } from "../../tools/context.js";
import type { ApprovalCtx } from "./arbiter.js";
import {
  buildGuardianApprovalRequest,
  compactForGuardianJson,
  guardianApprovalRequestActionText,
  guardianApprovalRequestPrettyJson,
} from "./approval-request.js";

function invocation(payload: ToolInvocation["payload"]): ToolInvocation {
  return {
    session: { services: {} } as never,
    turn: {
      subId: "turn-1",
      cwd: "/repo",
      approvalPolicy: { value: "on_request" },
      sandboxPolicy: { value: "workspace_write" },
    } as never,
    tracker: {
      appendFileDiff() {},
      snapshot: () => [],
      clear() {},
    },
    callId: "call-1",
    toolName: { name: "exec_command" },
    payload,
    source: "direct",
  };
}

function ctx(payload: ToolInvocation["payload"], toolName = "exec_command"): ApprovalCtx {
  return {
    invocation: {
      ...invocation(payload),
      toolName: { name: toolName },
    },
    callId: "call-1",
    toolName,
    turnId: "turn-1",
  };
}

describe("guardian approval request", () => {
  test("normalizes local shell requests and action text", () => {
    const request = buildGuardianApprovalRequest(
      ctx({
        kind: "local_shell",
        params: { command: ["bash", "-lc", "npm test"], cwd: "/repo" },
      }),
      { extra: true },
    );

    expect(request.kind).toBe("shell");
    expect(guardianApprovalRequestActionText(request)).toBe(
      '["bash","-lc","npm test"]',
    );
    expect(request.approvalPolicy).toBe("on_request");
    expect(request.sandboxPolicy).toBe("workspace_write");
  });

  test("serializes object keys stably and truncates recursive strings", () => {
    const request = buildGuardianApprovalRequest(
      ctx({ kind: "function", arguments: "{\"b\":2,\"a\":1}" }, "Write"),
      {
        z: "last",
        a: "x".repeat(4_500),
      },
    );
    const json = guardianApprovalRequestPrettyJson(request);

    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"z"'));
    expect(json).toContain("[... guardian approval string truncated ...]");
  });

  test("captures MCP server and payload metadata", () => {
    const request = buildGuardianApprovalRequest(
      ctx({ kind: "mcp", server: "db", tool: "query", rawArguments: "{}" }, "query"),
      { sql: "select 1" },
    );

    expect(request.kind).toBe("mcp_tool_call");
    expect(request.toolName).toBe("query");
    expect(guardianApprovalRequestActionText(request)).toContain("db.query");
  });

  test("normalizes network access and permission requests", () => {
    const network = buildGuardianApprovalRequest(
      ctx({ kind: "function", arguments: "{}" }, "network_access"),
      { url: "urn:agenc:test:network", port: 443 },
    );
    const permissions = buildGuardianApprovalRequest(
      ctx({ kind: "function", arguments: "{}" }, "request_permissions"),
      { permissions: ["filesystem.write", 42, "network"] },
    );

    expect(network).toMatchObject({
      kind: "network_access",
      url: "urn:agenc:test:network",
      port: 443,
    });
    expect(guardianApprovalRequestActionText(network)).toContain(
      "urn:agenc:test:network",
    );
    expect(permissions).toMatchObject({
      kind: "request_permissions",
      permissions: ["filesystem.write", "network"],
    });
    expect(guardianApprovalRequestActionText(permissions)).toContain(
      "filesystem.write, network",
    );
  });

  test("carries approval metadata without serializing network policy interfaces", () => {
    const policyDecider = { decide: () => ({ decision: "allow" as const }) };
    const blockedRequestObserver = { onBlockedRequest: () => undefined };
    const request = buildGuardianApprovalRequest(
      {
        ...ctx({ kind: "function", arguments: "{}" }, "exec_command"),
        networkPolicyDecider: policyDecider,
        blockedRequestObserver,
        additionalPermissions: {
          network: { enabled: true },
          file_system: { write: ["/tmp/agenc-extra"] },
        },
        availableDecisions: [{ kind: "approved" }, { kind: "abort" }],
      },
      {
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: { network: { enabled: true } },
      },
    );

    expect(request.additionalPermissions).toEqual({
      network: { enabled: true },
      file_system: { write: ["/tmp/agenc-extra"] },
    });
    expect(request.availableDecisions?.map((decision) => decision.kind)).toEqual([
      "approved",
      "abort",
    ]);
    expect("networkPolicyInterfaces" in request).toBe(false);
  });

  test("does not label generic url-bearing tools as network approval requests", () => {
    const request = buildGuardianApprovalRequest(
      ctx({ kind: "function", arguments: "{}" }, "BookmarkUrl"),
      { url: "urn:agenc:test:bookmark" },
    );

    expect(request.kind).toBe("tool");
    expect(guardianApprovalRequestActionText(request)).toContain("BookmarkUrl");
  });

  test("compacts generic tool payloads with circular, deep, and non-json values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let idx = 0; idx < 14; idx += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const longArray = Array.from({ length: 205 }, (_, idx) => idx);

    const request = buildGuardianApprovalRequest(
      ctx({ kind: "function", arguments: "{not json}" }, "CustomTool"),
      {
        bigint: 10n,
        circular,
        deep,
        fn: () => "ignored",
        longArray,
        symbol: Symbol("approval"),
      },
    );
    const json = guardianApprovalRequestPrettyJson(request);

    expect(request.kind).toBe("tool");
    expect(json).toContain('"bigint": "10"');
    expect(json).toContain('"self": "[circular]"');
    expect(json).toContain('"fn": "[function]"');
    expect(json).toContain('"symbol": "Symbol(approval)"');
    expect(json).toContain("[max depth]");
    expect(json).toContain("[... 5 more items truncated ...]");
  });

  test("malformed shell commands fall back to generic tool requests", () => {
    const request = buildGuardianApprovalRequest(
      ctx({ kind: "function", arguments: "{}" }, "exec_command"),
      { command: ["echo", 1], cwd: "/repo" },
    );

    expect(request.kind).toBe("tool");
    expect(compactForGuardianJson(request)).toMatchObject({
      kind: "tool",
      toolName: "exec_command",
    });
  });
});
