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

// Minimal ToolInvocation stub — ToolRouter.dispatchToolCall*
// only reads `toolName`, so we cast through unknown for the unused
// session/turn/tracker fields.
function makeInvocation(
  toolName: ToolName,
  callId = "c0",
): ToolInvocation {
  return {
    session: {} as ToolInvocation["session"],
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
  test("findSpec matches by full name", () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
      { tool: writeTool, supportsParallelToolCalls: false },
    ]);
    expect(router.findSpec("FileRead")?.tool).toBe(readTool);
    expect(router.findSpec("unknown")).toBeUndefined();
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
    // codex runtime `ToolSpec::Namespace | ToolSpec::ToolSearch |
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

  test("dispatchModelToolCall forwards approvalResolver into legacy requestApproval asks", async () => {
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
          services: {},
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
