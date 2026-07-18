import { describe, expect, test, vi } from "vitest";
import {
  buildToolCall,
  createDiffConsumer,
  ToolRouter,
  toolCallFromLLMToolCall,
} from "./router.js";
import type { RouterResponseItem } from "./router.js";
import type { ToolInvocation, ToolName } from "./context.js";
import type { Tool } from "./types.js";
import { EventLog } from "../session/event-log.js";
import type { GuardianApprovalReviewOptions } from "../permissions/guardian/reviewer.js";
import { buildGuardianApprovalRequest } from "../permissions/guardian/approval-request.js";

const readTool: Tool = {
  name: "FileRead",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};

const writeTool: Tool = {
  name: "Write",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};

const jsReplTool: Tool = {
  name: "js_repl",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "repl-ok" }),
};

// Minimal ToolInvocation stub. The execution boundary reads the session
// service container even when no sandbox broker is installed, so keep that
// required shape while casting the other unused fields.
function makeInvocation(
  toolName: ToolName,
  callId = "c0",
): ToolInvocation {
  return {
    session: {
      services: { admissionRequired: false },
    } as ToolInvocation["session"],
    turn: {} as ToolInvocation["turn"],
    tracker: {
      appendFileDiff: () => {},
      snapshot: () => [],
      clear: () => {},
    },
    callId,
    toolName,
    payload: { kind: "function", arguments: "{}" },
    source: "direct",
  };
}

describe("ToolRouter", () => {
  test("@ledger turn fails closed for every non-read-only model tool except the Ledger handoff", async () => {
    const readExecute = vi.fn(async () => ({ content: "read-ok" }));
    const writeExecute = vi.fn(async () => ({ content: "write-ok" }));
    const unclassifiedExecute = vi.fn(async () => ({ content: "unknown-ok" }));
    const ledgerExecute = vi.fn(async () => ({ content: "ledger-ok" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "safe.read",
          description: "",
          inputSchema: {},
          isReadOnly: true,
          recoveryCategory: "idempotent",
          metadata: { mutating: false },
          execute: readExecute,
        },
        supportsParallelToolCalls: true,
      },
      {
        tool: {
          name: "danger.write",
          description: "",
          inputSchema: {},
          isReadOnly: false,
          recoveryCategory: "side-effecting",
          metadata: { mutating: true },
          execute: writeExecute,
        },
        supportsParallelToolCalls: false,
      },
      {
        tool: {
          name: "unclassified.tool",
          description: "",
          inputSchema: {},
          metadata: { mutating: false },
          execute: unclassifiedExecute,
        },
        supportsParallelToolCalls: false,
      },
      {
        tool: {
          name: "request_ledger_transfer",
          description: "",
          inputSchema: {},
          isReadOnly: false,
          recoveryCategory: "interactive",
          metadata: { mutating: true },
          execute: ledgerExecute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const session = {
      eventLog: new EventLog(),
      services: { admissionRequired: false },
      currentRootHumanTurn: () => ({
        turnId: "turn-ledger",
        text: "@LEDGER send exactly 1 lamport",
      }),
    } as never;
    const opts = {
      session,
      turn: { subId: "turn-ledger" } as never,
      tracker: {
        appendFileDiff: () => {},
        snapshot: () => [],
        clear: () => {},
      },
      approvalPolicy: "never" as const,
      sandboxMode: "danger_full_access" as const,
    };

    const read = await router.dispatchModelToolCall(
      { id: "read", name: "safe.read", arguments: "{}" },
      opts,
    );
    const write = await router.dispatchModelToolCall(
      { id: "write", name: "danger.write", arguments: "{}" },
      opts,
    );
    const unclassified = await router.dispatchModelToolCall(
      { id: "unknown", name: "unclassified.tool", arguments: "{}" },
      opts,
    );
    const ledger = await router.dispatchModelToolCall(
      { id: "ledger", name: "request_ledger_transfer", arguments: "{}" },
      opts,
    );

    expect(read).toMatchObject({ content: "read-ok" });
    expect(write).toMatchObject({ isError: true });
    expect(write.content).toContain("request_ledger_transfer");
    expect(unclassified).toMatchObject({ isError: true });
    expect(ledger).toMatchObject({ content: "ledger-ok" });
    expect(readExecute).toHaveBeenCalledOnce();
    expect(writeExecute).not.toHaveBeenCalled();
    expect(unclassifiedExecute).not.toHaveBeenCalled();
    expect(ledgerExecute).toHaveBeenCalledOnce();
  });

  test("findSpec matches by full name", () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
      { tool: writeTool, supportsParallelToolCalls: false },
    ]);
    expect(router.findSpec("FileRead")?.tool).toBe(readTool);
    expect(router.findSpec("unknown")).toBeUndefined();
  });

  test("dispatchModelToolCall routes legacy Read calls to FileRead", async () => {
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      content: `read ${String(args.file_path)}`,
    }));
    const router = new ToolRouter([
      {
        tool: { ...readTool, execute },
        supportsParallelToolCalls: true,
      },
    ]);

    const result = await router.dispatchModelToolCall(
      {
        id: "call-read-alias",
        name: "Read",
        arguments: '{"file_path":"main.c"}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: { subId: "turn-read-alias" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("read main.c");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ file_path: "main.c" }),
    );
  });

  test("dispatchModelToolCall strips model-supplied __agenc* keys before tool.execute", async () => {
    // SECURITY (audit #1/#2/#4): `__agenc*` keys are a TRUSTED INTERNAL
    // channel. A model that emits `__agencSessionAllowedRoots:["/"]` must
    // never have it reach tool.execute, where it would widen filesystem
    // confinement.
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      content: `ok ${String(args.file_path)}`,
    }));
    const router = new ToolRouter([
      {
        tool: { ...writeTool, execute },
        supportsParallelToolCalls: true,
      },
    ]);

    const result = await router.dispatchModelToolCall(
      {
        id: "call-injection",
        name: "Write",
        arguments: JSON.stringify({
          file_path: "main.c",
          __agencSessionAllowedRoots: ["/"],
          __agencSessionId: "attacker-session",
          __agencHome: "/etc",
        }),
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: { subId: "turn-injection" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
      },
    );

    expect(result.isError).toBeFalsy();
    expect(execute).toHaveBeenCalledOnce();
    const received = execute.mock.calls[0]![0] as Record<string, unknown>;
    // Legitimate model-supplied args survive.
    expect(received.file_path).toBe("main.c");
    // Every model-supplied `__agenc*` key is stripped at the boundary.
    expect(received.__agencSessionAllowedRoots).toBeUndefined();
    expect(received.__agencHome).toBeUndefined();
    // The runtime may re-attach its own __agencSessionId (non-enumerable);
    // it must never be the attacker-controlled value.
    expect(received.__agencSessionId).not.toBe("attacker-session");
  });

  test("findSpec rejects MCP-serverId entry for plain (no-namespace) lookup (router behavior)", () => {
    // A spec registered with `serverId` (MCP umbrella) must not
    // resolve when the request has no namespace. This prevents a
    // function named `"a.b"` from accidentally resolving to a
    // namespace `"a"` tool `"b"` (AgenC behavior).
    const mcpTool: Tool = {
      name: "db.query",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ok" }),
    };
    const router = new ToolRouter([
      { tool: mcpTool, supportsParallelToolCalls: false, serverId: "db" },
    ]);
    // A plain (no-namespace) lookup of a name that happens to collide
    // must NOT return the MCP entry — since `serverId` is set.
    // Here we look up the literal stored key "db.query" which parses
    // into {namespace: "db", name: "query"}, so it goes through the
    // namespaced branch instead and matches via serverId.
    expect(router.findSpec("db.query")?.tool).toBe(mcpTool);
    // But a bare "db.query" request with explicit namespace:undefined
    // — represented by the ToolName shape — must not match.
    expect(router.findSpec({ name: "db.query" })).toBeUndefined();
  });

  test("findSpec namespaced lookup matches via serverId (router behavior)", () => {
    const mcpTool: Tool = {
      name: "query", // stored under the bare inner name
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ok" }),
    };
    const router = new ToolRouter([
      { tool: mcpTool, supportsParallelToolCalls: false, serverId: "db" },
    ]);
    expect(
      router.findSpec({ namespace: "db", name: "query" })?.tool,
    ).toBe(mcpTool);
    // Namespace mismatch → undefined.
    expect(
      router.findSpec({ namespace: "other", name: "query" }),
    ).toBeUndefined();
  });

  test("toolSupportsParallel true for parallel-safe function tool", () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
    ]);
    expect(
      router.toolSupportsParallel({
        toolName: { name: "FileRead" },
        callId: "c1",
        payload: { kind: "function", arguments: "" },
      }),
    ).toBe(true);
  });

  test("toolSupportsParallel false for non-parallel function tool", () => {
    const router = new ToolRouter([
      { tool: writeTool, supportsParallelToolCalls: false },
    ]);
    expect(
      router.toolSupportsParallel({
        toolName: { name: "Write" },
        callId: "c2",
        payload: { kind: "function", arguments: "" },
      }),
    ).toBe(false);
  });

  test("toolSupportsParallel false for namespaced tool name even when base spec is parallel (router behavior)", () => {
    // AgenC behavior test: a function spec (`shell`) that advertises
    // `supports_parallel_tool_calls = true` must still return `false`
    // when invoked under a namespaced name
    // (`mcp__server__shell`). Checked BEFORE spec lookup so the
    // underlying flag can never leak `true`.
    const parallelShell: Tool = {
      name: "shell",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ok" }),
    };
    const router = new ToolRouter([
      { tool: parallelShell, supportsParallelToolCalls: true },
    ]);
    // Baseline: the unnamespaced call is parallel.
    expect(
      router.toolSupportsParallel({
        toolName: { name: "shell" },
        callId: "call-parallel-tool",
        payload: { kind: "function", arguments: "{}" },
      }),
    ).toBe(true);
    // The namespaced form must short-circuit to false.
    expect(
      router.toolSupportsParallel({
        toolName: { namespace: "mcp__server__", name: "shell" },
        callId: "call-namespaced-tool",
        payload: { kind: "function", arguments: "{}" },
      }),
    ).toBe(false);
  });

  test("toolSupportsParallel hard-false for non-Function/Freeform spec variants (router behavior)", () => {
    // Donor runtime `ToolSpec::Namespace | ToolSpec::ToolSearch |
    // ToolSpec::LocalShell | ToolSpec::ImageGeneration |
    // ToolSpec::WebSearch` are hard-coded non-parallel regardless of
    // the `supports_parallel_tool_calls` flag.
    const shellLike = (name: string): Tool => ({
      name,
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ok" }),
    });
    const router = new ToolRouter([
      { tool: shellLike("tool_search"), supportsParallelToolCalls: true },
      { tool: shellLike("local_shell"), supportsParallelToolCalls: true },
      { tool: shellLike("image_generation"), supportsParallelToolCalls: true },
      { tool: shellLike("web_search"), supportsParallelToolCalls: true },
    ]);
    for (const name of [
      "tool_search",
      "local_shell",
      "image_generation",
      "web_search",
    ]) {
      expect(
        router.toolSupportsParallel({
          toolName: { name },
          callId: `call-${name}`,
          payload: { kind: "function", arguments: "{}" },
        }),
      ).toBe(false);
    }
  });

  test("MCP tools use parallelMcpServerNames allowlist", () => {
    const router = new ToolRouter(
      [{ tool: readTool, supportsParallelToolCalls: true }],
      { parallelMcpServerNames: new Set(["dbA"]) },
    );
    expect(
      router.toolSupportsParallel({
        toolName: { name: "query" },
        callId: "c3",
        payload: { kind: "mcp", server: "dbA", tool: "query", rawArguments: "" },
      }),
    ).toBe(true);
    expect(
      router.toolSupportsParallel({
        toolName: { name: "query" },
        callId: "c4",
        payload: { kind: "mcp", server: "dbZ", tool: "query", rawArguments: "" },
      }),
    ).toBe(false);
  });

  test("toolCallFromLLMToolCall routes mcp tools by namespace (legacy fallback)", () => {
    const call = toolCallFromLLMToolCall({
      id: "c1",
      name: "mcp.github.listIssues",
      arguments: "{}",
    });
    expect(call.payload.kind).toBe("mcp");
  });

  test("toolCallFromLLMToolCall prefers mcpManager.resolveMcpToolInfo over prefix", () => {
    const session = {
      services: {
        mcpManager: {
          resolveMcpToolInfo: (name: string) =>
            name === "github.listIssues"
              ? { serverName: "github", toolName: "listIssues" }
              : undefined,
        },
      },
    };
    const call = toolCallFromLLMToolCall(
      { id: "c1", name: "github.listIssues", arguments: "{}" },
      { session },
    );
    expect(call.payload.kind).toBe("mcp");
    if (call.payload.kind === "mcp") {
      expect(call.payload.server).toBe("github");
      expect(call.payload.tool).toBe("listIssues");
    }
  });

  test("toolCallFromLLMToolCall falls back to function when session has no mcpManager match", () => {
    const session = {
      services: {
        mcpManager: {
          resolveMcpToolInfo: () => undefined,
        },
      },
    };
    // Without a session match, a plain name resolves to function —
    // even if the name looks like it could be mcp-namespaced.
    const call = toolCallFromLLMToolCall(
      { id: "c2", name: "mcp.github.listIssues", arguments: "{}" },
      { session },
    );
    expect(call.payload.kind).toBe("function");
  });
});

describe("buildToolCall — ResponseItem variants", () => {
  test("function_call → ToolPayload.function", async () => {
    const item: RouterResponseItem = {
      type: "function_call",
      callId: "c1",
      name: "FileRead",
      arguments: '{"path":"/tmp"}',
    };
    const call = await buildToolCall(undefined, item);
    expect(call).not.toBeNull();
    expect(call!.toolName.name).toBe("FileRead");
    expect(call!.callId).toBe("c1");
    expect(call!.payload.kind).toBe("function");
    if (call!.payload.kind === "function") {
      expect(call!.payload.arguments).toBe('{"path":"/tmp"}');
    }
  });

  test("function_call with MCP resolution → ToolPayload.mcp", async () => {
    const session = {
      services: {
        mcpManager: {
          resolveMcpToolInfo: (name: string) =>
            name === "mcp.github.listIssues"
              ? { serverName: "github", toolName: "listIssues" }
              : undefined,
        },
      },
    };
    const item: RouterResponseItem = {
      type: "function_call",
      callId: "c1",
      name: "listIssues",
      namespace: "mcp.github",
      arguments: "{}",
    };
    const call = await buildToolCall(session, item);
    expect(call).not.toBeNull();
    expect(call!.payload.kind).toBe("mcp");
    if (call!.payload.kind === "mcp") {
      expect(call!.payload.server).toBe("github");
      expect(call!.payload.tool).toBe("listIssues");
      expect(call!.toolName.namespace).toBe("github");
    }
  });

  test("tool_search_call → ToolPayload.tool_search", async () => {
    const item: RouterResponseItem = {
      type: "tool_search_call",
      callId: "ts1",
      execution: "client",
      arguments: { query: "grep" },
    };
    const call = await buildToolCall(undefined, item);
    expect(call).not.toBeNull();
    expect(call!.toolName.name).toBe("tool_search");
    expect(call!.payload.kind).toBe("tool_search");
    if (call!.payload.kind === "tool_search") {
      expect(call!.payload.arguments.query).toBe("grep");
    }
  });

  test("tool_search_call with non-client execution → null", async () => {
    const item: RouterResponseItem = {
      type: "tool_search_call",
      callId: "ts1",
      execution: "server",
      arguments: { query: "x" },
    };
    expect(await buildToolCall(undefined, item)).toBeNull();
  });

  test("custom_tool_call → ToolPayload.custom", async () => {
    const item: RouterResponseItem = {
      type: "custom_tool_call",
      callId: "cc1",
      name: "my_custom",
      input: "raw blob",
    };
    const call = await buildToolCall(undefined, item);
    expect(call).not.toBeNull();
    expect(call!.toolName.name).toBe("my_custom");
    expect(call!.payload.kind).toBe("custom");
    if (call!.payload.kind === "custom") {
      expect(call!.payload.input).toBe("raw blob");
    }
  });

  test("local_shell_call → ToolPayload.local_shell", async () => {
    const item: RouterResponseItem = {
      type: "local_shell_call",
      callId: "ls1",
      action: {
        type: "exec",
        command: ["echo", "hi"],
        workingDirectory: "/tmp",
        timeoutMs: 5_000,
      },
    };
    const call = await buildToolCall(undefined, item);
    expect(call).not.toBeNull();
    expect(call!.toolName.name).toBe("local_shell");
    expect(call!.payload.kind).toBe("local_shell");
    if (call!.payload.kind === "local_shell") {
      expect(call!.payload.params.command).toEqual(["echo", "hi"]);
      expect(call!.payload.params.cwd).toBe("/tmp");
      expect(call!.payload.params.timeoutMs).toBe(5_000);
    }
  });

  test("local_shell_call falls back to id when callId missing", async () => {
    const item: RouterResponseItem = {
      type: "local_shell_call",
      id: "alt1",
      action: { type: "exec", command: ["ls"] },
    };
    const call = await buildToolCall(undefined, item);
    expect(call?.callId).toBe("alt1");
  });
});

describe("ToolRouter.dispatchToolCallWithCodeMode", () => {
  test("blocks non-JS-REPL tools under code_mode source", async () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
    ]);
    const inv = makeInvocation({ name: "FileRead" }, "c1");
    const result = await router.dispatchToolCallWithCodeMode(
      inv,
      {},
      "code_mode",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("code_mode");
  });

  test("allows js_repl under code_mode source", async () => {
    const router = new ToolRouter([
      { tool: jsReplTool, supportsParallelToolCalls: false },
    ]);
    const inv = makeInvocation({ name: "js_repl" }, "c2");
    const result = await router.dispatchToolCallWithCodeMode(
      inv,
      {},
      "code_mode",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("repl-ok");
  });

  test("direct source dispatches normally", async () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
    ]);
    const inv = makeInvocation({ name: "FileRead" }, "c3");
    const result = await router.dispatchToolCallWithCodeMode(
      inv,
      {},
      "direct",
    );
    expect(result.content).toBe("ok");
  });

  test("direct dispatch consults guardian approval before executing approval-required tools", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          requiresApproval: true,
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const reviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reason: "direct guardian denied",
        reviewId: "direct-guardian-review",
        countedDenial: true,
      })),
    };
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };
    const invocation: ToolInvocation = {
      ...makeInvocation({ name: "Write" }, "direct-approval"),
      session: {
        eventLog: new EventLog(),
        services: { admissionRequired: false },
      } as never,
      turn: {
        subId: "turn-direct-approval",
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "workspace_write" },
        config: { approvalsReviewer: "auto_review" },
      } as never,
    };

    const result = await router.dispatchToolCall(
      invocation,
      { file_path: "README.md" },
      {
        guardianApprovalReviewer: reviewer,
        approvalResolver: resolver,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("direct guardian denied");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("direct dispatch permission-mode deny blocks execution before approval", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const invocation = makeInvocation({ name: "Write" }, "direct-deny");

    const result = await router.dispatchToolCall(
      invocation,
      { file_path: "README.md" },
      {
        canUseTool: vi.fn(async () => ({
          behavior: "deny" as const,
          message: "blocked by permission mode",
        })),
        permissionContext: {} as never,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked by permission mode");
    expect(execute).not.toHaveBeenCalled();
  });

  test("direct dispatch timeout aborts the underlying tool signal", async () => {
    let sawRuntimeSignal = false;
    let signalAborted = false;
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      const signal = args["__abortSignal"];
      sawRuntimeSignal = signal instanceof AbortSignal;
      return await new Promise<{ readonly content: string; readonly isError: true }>(
        (resolve) => {
          if (!(signal instanceof AbortSignal)) return;
          signal.addEventListener(
            "abort",
            () => {
              signalAborted = true;
              resolve({ content: "aborted", isError: true });
            },
            { once: true },
          );
        },
      );
    });
    const router = new ToolRouter([
      {
        tool: {
          name: "DirectTimeoutTool",
          description: "",
          inputSchema: {},
          timeoutMs: 10,
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);

    const result = await router.dispatchToolCall(
      makeInvocation({ name: "DirectTimeoutTool" }, "direct-timeout"),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeded 10ms timeout");
    expect(sawRuntimeSignal).toBe(true);
    expect(signalAborted).toBe(true);
  });

  test("direct dispatch permission-mode ask routes through guardian before resolver", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const reviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reason: "guardian denied direct ask",
        reviewId: "direct-ask-guardian-review",
        countedDenial: true,
      })),
    };
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };
    const invocation: ToolInvocation = {
      ...makeInvocation({ name: "Write" }, "direct-ask"),
      session: {
        eventLog: new EventLog(),
        services: { admissionRequired: false },
      } as never,
      turn: {
        subId: "turn-direct-ask",
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "workspace_write" },
        config: { approvalsReviewer: "auto_review" },
      } as never,
    };

    const result = await router.dispatchToolCall(
      invocation,
      { file_path: "README.md" },
      {
        canUseTool: vi.fn(async () => ({
          behavior: "ask" as const,
          message: "approval required by permission mode",
        })),
        permissionContext: {} as never,
        guardianApprovalReviewer: reviewer,
        approvalResolver: resolver,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("guardian denied direct ask");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("dispatchModelToolCall forwards evaluator asks to approvalResolver when guardian is not configured", async () => {
    const router = new ToolRouter([
      {
        tool: {
          name: "system.listDir",
          description: "",
          inputSchema: {},
          execute: async () => ({ content: "listed" }),
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };

    const result = await router.dispatchModelToolCall(
      {
        id: "call-list-dir",
        name: "system.listDir",
        arguments: '{"path":"."}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: { subId: "turn-approval-1" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        approvalResolver: resolver,
        canUseTool: async () => ({
          behavior: "ask",
          message: "Permission required to use system.listDir",
        }),
        permissionContext: {} as never,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("listed");
    expect(resolver.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-list-dir",
        toolName: "system.listDir",
        turnId: "turn-approval-1",
      }),
    );
  });

  test("dispatchModelToolCall routes evaluator ask through guardian without pre-hooks", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "system.listDir",
          description: "",
          inputSchema: {},
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const reviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reason: "guardian denied evaluator ask",
        reviewId: "guardian-review-evaluator-ask",
        countedDenial: true,
      })),
    };
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };

    const result = await router.dispatchModelToolCall(
      {
        id: "call-evaluator-ask",
        name: "system.listDir",
        arguments: '{"path":"."}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-evaluator-ask",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
          config: { approvalsReviewer: "auto_review" },
        } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        guardianApprovalReviewer: reviewer,
        approvalResolver: resolver,
        canUseTool: async () => ({
          behavior: "ask",
          message: "Permission required to use system.listDir",
        }),
        permissionContext: {} as never,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("guardian denied evaluator ask");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("dispatchModelToolCall blocks execution when guardian denies approval", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          requiresApproval: true,
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const reviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reviewId: "guardian-review-1",
        countedDenial: true,
        reason: "guardian denied",
      })),
    };
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };

    const result = await router.dispatchModelToolCall(
      {
        id: "call-guardian-denied",
        name: "Write",
        arguments: '{"file_path":"README.md"}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-guardian-denied",
          cwd: "/repo",
          approvalPolicy: { value: "on_request" },
          sandboxPolicy: { value: "workspace_write" },
          config: { approvalsReviewer: "auto_review" },
        } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        guardianApprovalReviewer: reviewer,
        approvalResolver: resolver,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("guardian denied");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("dispatchModelToolCall threads turn network policy interfaces into guardian approval context", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const policyDecider = {
      decide: vi.fn(async () => ({ decision: "allow" as const })),
    };
    const blockedRequestObserver = {
      onBlockedRequest: vi.fn(async () => {}),
    };
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          requiresApproval: true,
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const observedRequests: unknown[] = [];
    const observedInterfaces: Array<
      Pick<
        GuardianApprovalReviewOptions["ctx"],
        "networkPolicyDecider" | "blockedRequestObserver"
      >
    > = [];
    const reviewer = {
      reviewApprovalRequest: vi.fn(
        async ({ ctx, args }: GuardianApprovalReviewOptions) => {
          observedInterfaces.push({
            networkPolicyDecider: ctx.networkPolicyDecider,
            blockedRequestObserver: ctx.blockedRequestObserver,
          });
          observedRequests.push(buildGuardianApprovalRequest(ctx, args ?? {}));
          return {
            decision: { kind: "denied" as const },
            reviewId: "guardian-review-network-interfaces",
            countedDenial: true,
            reason: "guardian inspected network policy interfaces",
          };
        },
      ),
    };
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };

    const result = await router.dispatchModelToolCall(
      {
        id: "call-guardian-network-interfaces",
        name: "Write",
        arguments: '{"file_path":"README.md"}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-guardian-network-interfaces",
          cwd: "/repo",
          approvalPolicy: { value: "on_request" },
          sandboxPolicy: { value: "workspace_write" },
          config: { approvalsReviewer: "auto_review" },
          network: {
            policyDecider,
            blockedRequestObserver,
          },
        } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        guardianApprovalReviewer: reviewer,
        approvalResolver: resolver,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "guardian inspected network policy interfaces",
    );
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(observedRequests).toEqual([
      expect.objectContaining({
        callId: "call-guardian-network-interfaces",
        turnId: "turn-guardian-network-interfaces",
        toolName: "Write",
      }),
    ]);
    expect(observedInterfaces).toEqual([
      {
        networkPolicyDecider: policyDecider,
        blockedRequestObserver,
      },
    ]);
    expect(
      observedRequests.every(
        (request) =>
          !("networkPolicyInterfaces" in (request as Record<string, unknown>)),
      ),
    ).toBe(true);
  });

  test("dispatchModelToolCall routes pre-hook ask through guardian even when turn policy skips", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const reviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reviewId: "guardian-review-hook-ask",
        countedDenial: true,
        reason: "guardian denied hook ask",
      })),
    };
    const resolver = {
      request: vi.fn(async () => ({ kind: "approved" as const })),
    };

    const result = await router.dispatchModelToolCall(
      {
        id: "call-hook-ask",
        name: "Write",
        arguments: '{"file_path":"README.md"}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-hook-ask",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "workspace_write" },
          config: { approvalsReviewer: "auto_review" },
        } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        preHooks: [
          () => ({
            kind: "continue" as const,
            hookPermissionResult: {
              behavior: "ask" as const,
              message: "hook requested approval",
            },
          }),
        ],
        guardianApprovalReviewer: reviewer,
        approvalResolver: resolver,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("guardian denied hook ask");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("dispatchModelToolCall preserves BigInt args after pre-hook rewrites", async () => {
    let observedArgs: Record<string, unknown> | undefined;
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      observedArgs = args;
      return { content: "ok" };
    });
    const router = new ToolRouter([
      {
        tool: {
          name: "BigIntEcho",
          description: "",
          inputSchema: {},
          isReadOnly: true,
          execute,
        },
        supportsParallelToolCalls: true,
      },
    ]);

    const result = await router.dispatchModelToolCall(
      {
        id: "call-model-bigint-rewrite",
        name: "BigIntEcho",
        arguments: '{"lamports":900719925474099312345,"path":"original"}',
      },
      {
        session: {
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: {
          subId: "turn-model-bigint-rewrite",
          cwd: "/repo",
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "read_only",
        preHooks: [
          ({ args }) => ({
            kind: "continue" as const,
            args: { ...args, path: "rewritten" },
          }),
        ],
      },
    );

    expect(result.isError).toBeFalsy();
    expect(execute).toHaveBeenCalledOnce();
    expect(observedArgs).toMatchObject({ path: "rewritten" });
    expect(observedArgs?.["lamports"]).toBe(900719925474099312345n);
  });

  test("dispatchModelToolCall audits terminal pre-hook denials once", async () => {
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          execute: async () => ({ content: "should-not-run" }),
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const auditLogger = vi.fn(async () => {});

    const result = await router.dispatchModelToolCall(
      {
        id: "call-denied",
        name: "Write",
        arguments: '{"command":"echo api_key=abcdefghijklmnopqrstuvwxyz123456"}',
      },
      {
        session: {
          conversationId: "session_router",
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: { subId: "turn-denied" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        preHooks: [() => ({ kind: "deny", reason: "blocked" })],
        permissionAuditLogger: auditLogger,
      },
    );

    expect(result.isError).toBe(true);
    expect(auditLogger).toHaveBeenCalledTimes(1);
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "policy_outcome",
        decision: "denied",
        source: "pre-tool-use-hook",
        subjectType: "tool_execution",
        toolName: "Write",
        callId: "call-denied",
        sessionId: "session_router",
        reasonCode: "pre_hook_denied",
      }),
    );
    expect(JSON.stringify(auditLogger.mock.calls)).not.toContain(
      "abcdefghijklmnopqrstuvwxyz123456",
    );
  });

  test("dispatchModelToolCall audits classifier approval skips", async () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const auditLogger = vi.fn(async () => {});
    const resolver = {
      request: vi.fn(async () => ({ kind: "denied" as const })),
    };
    const reviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reviewId: "guardian-review-skip",
        countedDenial: true,
      })),
    };

    const result = await router.dispatchModelToolCall(
      {
        id: "call-auto-approved",
        name: "Write",
        arguments: JSON.stringify({ file_path: "src/auto-approved.txt" }),
      },
      {
        session: {
          conversationId: "session_router",
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: { subId: "turn-auto-approved" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        permissionAuditLogger: auditLogger,
        approvalResolver: resolver,
        guardianApprovalReviewer: reviewer,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(execute).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(reviewer.reviewApprovalRequest).not.toHaveBeenCalled();
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "policy_outcome",
        decision: "approved",
        source: "approval-classifier",
        subjectType: "tool_execution",
        toolName: "Write",
        callId: "call-auto-approved",
        sessionId: "session_router",
        reasonCode: "policy_never_skipped",
      }),
    );
  });

  test("dispatchModelToolCall audits forbidden classifier denials", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run" }));
    const router = new ToolRouter([
      {
        tool: {
          name: "Write",
          description: "",
          inputSchema: {},
          execute,
        },
        supportsParallelToolCalls: false,
      },
    ]);
    const auditLogger = vi.fn(async () => {});

    const result = await router.dispatchModelToolCall(
      {
        id: "call-forbidden",
        name: "Write",
        arguments: "{}",
      },
      {
        session: {
          conversationId: "session_router",
          eventLog: new EventLog(),
          services: { admissionRequired: false },
        } as never,
        turn: { subId: "turn-forbidden" } as never,
        tracker: {
          appendFileDiff: () => {},
          snapshot: () => [],
          clear: () => {},
        },
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        permissionAuditLogger: auditLogger,
        toolDenylist: new Set(["Write"]),
      },
    );

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "policy_outcome",
        decision: "denied",
        source: "approval-classifier",
        subjectType: "tool_execution",
        toolName: "Write",
        callId: "call-forbidden",
        sessionId: "session_router",
        reasonCode: "tool_denylisted",
      }),
    );
  });
});

describe("ToolRouter.fromConfig", () => {
  test("merges mcpTools + dynamicTools + deferredMcpTools", () => {
    const mcpTool: Tool = {
      name: "mcp.db.query",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "q" }),
    };
    const deferredTool: Tool = {
      name: "mcp.db.migrate",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "m" }),
    };
    const dynamicTool: Tool = {
      name: "dyn.echo",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "e" }),
    };
    const router = ToolRouter.fromConfig({
      baseSpecs: [{ tool: readTool, supportsParallelToolCalls: true }],
      mcpTools: new Map([["mcp.db.query", mcpTool]]),
      deferredMcpTools: new Map([["mcp.db.migrate", deferredTool]]),
      dynamicTools: [dynamicTool],
    });

    const specs = router.getSpecs();
    const names = new Set(specs.map((s) => s.tool.name));
    expect(names.has("FileRead")).toBe(true);
    expect(names.has("mcp.db.query")).toBe(true);
    expect(names.has("mcp.db.migrate")).toBe(true);
    expect(names.has("dyn.echo")).toBe(true);

    expect(router.findSpec("mcp.db.migrate")?.deferred).toBe(true);
    expect(router.findSpec("dyn.echo")?.dynamic).toBe(true);
  });

  test("unavailableCalledTools flags specs without removing them", () => {
    const tool: Tool = {
      name: "blocked.tool",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "" }),
    };
    const router = ToolRouter.fromConfig({
      dynamicTools: [tool],
      unavailableCalledTools: ["blocked.tool"],
    });
    expect(router.findSpec("blocked.tool")?.unavailable).toBe(true);
  });

  test("modelVisibleSpecs hides deferred tools", () => {
    const deferred: Tool = {
      name: "mcp.x.hidden",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "" }),
    };
    const router = ToolRouter.fromConfig({
      baseSpecs: [{ tool: readTool, supportsParallelToolCalls: true }],
      deferredMcpTools: new Map([["mcp.x.hidden", deferred]]),
    });
    const visible = router.modelVisibleSpecs().map((t) => t.function.name);
    expect(visible).toContain("FileRead");
    expect(visible).not.toContain("mcp.x.hidden");
  });
});

describe("createDiffConsumer", () => {
  test("records + compares identical inputs returns empty diff", () => {
    const consumer = createDiffConsumer("Edit");
    consumer.record("path", "/tmp/a");
    expect(consumer.compare("path", "/tmp/a")).toBe("");
  });

  test("records + compares different inputs returns unified diff", () => {
    const consumer = createDiffConsumer("Edit");
    consumer.record("content", "line1\nline2");
    const diff = consumer.compare("content", "line1\nline2-edited");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+line2-edited");
    expect(consumer.snapshot()).toHaveLength(1);
  });

  test("compare without prior record returns null", () => {
    const consumer = createDiffConsumer("Edit");
    expect(consumer.compare("unknown", "x")).toBeNull();
  });

  test("ToolRouter.createDiffConsumer returns the same shape", () => {
    const router = new ToolRouter([]);
    const consumer = router.createDiffConsumer({ name: "Edit" });
    expect(typeof consumer.record).toBe("function");
    expect(typeof consumer.compare).toBe("function");
    expect(consumer.toolName).toBe("Edit");
  });
});
