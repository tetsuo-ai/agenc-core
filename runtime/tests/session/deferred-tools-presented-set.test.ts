/**
 * The deferred-tools notice must not tell the model that a loaded tool is gone
 * while the request still carries it. On native DeepSeek Light the stable core
 * catalog, the model's edit tool, plan mode and the web search picker decide
 * what a request presents, so a discovered tool can move from discovery-only
 * presentation into the presented catalog and stay callable (0.19.29 batch
 * review, finding 1). Each case drives the production registry and producer
 * with what run-turn passes them for one request: registry.toLLMTools() and
 * getLoadedDeferredToolNames().
 */
import { expect, test, vi } from "vitest";
import { buildFilteredRegistry, TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH } from "../../src/agents/run-agent.js";
import { deferredToolsDeltaProducer } from "../../src/prompts/attachments/deferred-tools-delta.js";
import type { GetAttachmentsOptions } from "../../src/prompts/attachments/orchestrator.js";
import { _resetAttachmentTrackingStateForTest, getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { markLoadedToolNamesDiscovered } from "../../src/tools/deferred-discovery.js";
import type { Tool } from "../../src/tools/types.js";
import { explicitDangerBroker, withExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";

type Live = { provider: string; model: string; mode: string; webSearch: boolean };

function webTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    recoveryCategory: "read-only",
    execute: async () => ({ content: "ok" }),
  } as unknown as Tool;
}

function lightSession(initial: Partial<Live>) {
  const live: Live = { provider: "deepseek", model: "deepseek-flash", mode: "default", webSearch: false, ...initial };
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, deferRareTools: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    webSearchEnabled: () => live.webSearch,
    extraTools: [webTool("WebSearch"), webTool("web_fetch")],
    getSession: () => ({ services: {
      provider: { name: live.provider },
      providerService: { current: () => ({ provider: live.provider, model: live.model }) },
      permissionModeRegistry: { current: () => ({ mode: live.mode }) },
    } }) as unknown as Session,
    unifiedExecManager: {
      maxTimeoutMs: Infinity,
      execCommand: vi.fn(async () => ({ stdout: "", stderr: "", output: "", exitCode: null, process_id: 71,
        exit_code: null, wall_time_seconds: 0.001, original_token_count: 0, timedOut: false, truncated: false, durationMs: 1 })),
      writeStdin: vi.fn(), closeAll: vi.fn(async () => {}),
    },
  });
  const sessionKey = {};
  const names = () => registry.toLLMTools().map((tool) => tool.function.name);
  const request = () => notice(registry, sessionKey, live.mode);
  const yieldProcess = async () => {
    const result = await registry.tools.find((tool) => tool.name === "exec_command")!
      .execute(withExplicitDangerBoundary({ cmd: "npm run dev", yield_time_ms: 250 }));
    expect(result.isError, String(result.content)).not.toBe(true);
  };
  // system.searchTools loads tools for the next request as execute-tools does.
  const searchLoad = async (...toolNames: string[]) => {
    const search = registry.tools.find((tool) => tool.name === "system.searchTools")!;
    const result = await search.execute({ query: `select:${toolNames.join(",")}` });
    markLoadedToolNamesDiscovered(search.name, result, registry.getDiscoveredToolNames?.());
    expect([...registry.getDiscoveredToolNames!()]).toEqual(expect.arrayContaining(toolNames));
  };
  return { live, registry, names, request, yieldProcess, searchLoad, dispose: () => _resetAttachmentTrackingStateForTest(sessionKey) };
}

type NoticeRegistry = Pick<ReturnType<typeof buildToolRegistry>, "toLLMTools" | "getLoadedDeferredToolNames" | "getDiscoveredToolNames">;

/** The deferred-tools notice of one request, from what run-turn passes the producer. */
function notice(registry: NoticeRegistry, sessionKey: object, mode = "default") {
  return deferredToolsDeltaProducer({
    sessionKey, userInput: null,
    loadedTools: registry.toLLMTools(),
    discoveredToolNames: registry.getLoadedDeferredToolNames?.() ?? registry.getDiscoveredToolNames?.() ?? new Set(),
    messages: [], permissionContext: { mode } as never, cwd: "/tmp", subagentDepth: 0,
    signal: new AbortController().signal,
  } as GetAttachmentsOptions, getAttachmentTrackingState(sessionKey));
}

/** A Light child of the session, as run-agent builds one, and its own exec yield. */
function lightChild(parent: ReturnType<typeof buildToolRegistry>) {
  const registry = buildFilteredRegistry(parent, {
    childConversationId: "child", lightMode: true, sandboxExecutionBroker: explicitDangerBroker,
    unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
  }) as unknown as NoticeRegistry & ReturnType<typeof buildFilteredRegistry>;
  const sessionKey = {};
  const yieldProcess = async () => {
    const result = await registry.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"npm run dev","yield_time_ms":250}' });
    expect(result.isError, String(result.content)).not.toBe(true);
    expect(result.content).toContain("session_id=71");
  };
  return { registry, yieldProcess, request: () => notice(registry, sessionKey), dispose: () => _resetAttachmentTrackingStateForTest(sessionKey) };
}

const added = (names: string[]) => [expect.objectContaining({ kind: "deferred_tools_delta", addedNames: names, removedNames: [] })];

test("an OpenAI Light exec yield, then a switch to native DeepSeek Light, keeps both process tools listed and announced", async () => {
  const session = lightSession({ provider: "openai", model: "gpt-6-luna" });
  try {
    expect(await session.request()).toEqual([]);
    await session.yieldProcess();
    expect(await session.request()).toEqual(added(["kill_process", "write_stdin"]));

    session.live.provider = "deepseek";
    session.live.model = "deepseek-flash";
    expect(session.names()).toEqual(expect.arrayContaining(["write_stdin", "kill_process"]));
    expect(await session.request()).toEqual([]);

    session.live.provider = "openai";
    session.live.model = "gpt-6-luna";
    expect(session.names()).toEqual(expect.arrayContaining(["write_stdin", "kill_process"]));
    expect(await session.request()).toEqual([]);
  } finally {
    session.dispose();
  }
});

test("plan mode on native DeepSeek Light does not remove the plan tools that search loaded", async () => {
  const session = lightSession({});
  try {
    expect(await session.request()).toEqual([]);
    await session.searchLoad("AskUserQuestion", "ExitPlanMode");
    expect(await session.request()).toEqual(added(["AskUserQuestion", "ExitPlanMode"]));

    session.live.mode = "plan";
    expect(session.names()).toEqual(expect.arrayContaining(["AskUserQuestion", "ExitPlanMode"]));
    expect(await session.request()).toEqual([]);

    session.live.mode = "default";
    expect(await session.request()).toEqual([]);
  } finally {
    session.dispose();
  }
});

test("web search going from auto to on does not remove the web tools that search loaded", async () => {
  const session = lightSession({});
  try {
    expect(await session.request()).toEqual([]);
    await session.searchLoad("WebSearch");
    expect(await session.request()).toEqual(added(["WebSearch"]));

    session.live.webSearch = true;
    expect(session.names()).toEqual(expect.arrayContaining(["WebSearch", "web_fetch"]));
    expect(await session.request()).toEqual([]);
  } finally {
    session.dispose();
  }
});

test("a deepseek-v4-pro to deepseek-flash switch does not remove the apply_patch tool that search loaded", async () => {
  const session = lightSession({ model: "deepseek-v4-pro" });
  try {
    expect(session.names()).not.toContain("apply_patch");
    expect(await session.request()).toEqual([]);
    await session.searchLoad("apply_patch");
    expect(await session.request()).toEqual(added(["apply_patch"]));

    session.live.model = "deepseek-flash";
    expect(session.names()).toContain("apply_patch");
    expect(await session.request()).toEqual([]);
  } finally {
    session.dispose();
  }
});

test.each(["deepseek-flash", "deepseek-v4-pro"])("a native DeepSeek Light (%s) child's own exec yield keeps its tool list and sends no notice", async (model) => {
  const session = lightSession({ model });
  const child = lightChild(session.registry);
  try {
    const before = JSON.stringify(child.registry.toLLMTools());
    expect(child.registry.toLLMTools().map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["write_stdin", "kill_process"]));
    expect(await child.request()).toEqual([]);
    await child.yieldProcess();
    expect([...child.registry.getDiscoveredToolNames!()].sort()).toEqual(["kill_process", "write_stdin"]);
    // The parent presented both companions in full at spawn; the child keeps
    // those entries byte for byte, so its cached prompt survives the yield.
    expect(JSON.stringify(child.registry.toLLMTools())).toBe(before);
    expect(await child.request()).toEqual([]);
  } finally {
    child.dispose();
    session.dispose();
  }
});

test("an OpenAI Light child's own exec yield still adds and announces both process tools", async () => {
  const session = lightSession({ provider: "openai", model: "gpt-6-luna" });
  const child = lightChild(session.registry);
  try {
    expect(child.registry.toLLMTools().map((tool) => tool.function.name)).not.toContain("write_stdin");
    expect(await child.request()).toEqual([]);
    await child.yieldProcess();
    expect(child.registry.toLLMTools().map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["write_stdin", "kill_process"]));
    expect(await child.request()).toEqual(added(["kill_process", "write_stdin"]));
  } finally {
    child.dispose();
    session.dispose();
  }
});

function mcpTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    recoveryCategory: "read-only",
    execute: async () => ({ content: "ok" }),
  } as unknown as Tool;
}

test.each([
  { policy: "deferMcpTools = false", options: { deferMcpTools: false } },
  { policy: "a policy without system.searchTools", options: { toolsConfig: { disabled_tools: ["system.searchTools"] } } },
])("native DeepSeek Light announces a presented MCP tool the user names and its server disconnect ($policy)", async ({ options }) => {
  // 0.19.29 batch re-review NIT 1: the tool is presented without search, so
  // the stable catalog rule kept it out of both notices; on 0.19.28 the user
  // naming it announced it (with the call-it-directly nudge) and its server
  // disconnecting announced the removal.
  let connected = true;
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    mcpToolsProvider: { getTools: () => connected ? [mcpTool("mcp.docs.search")] : [] },
    getSession: () => ({ services: {
      provider: { name: "deepseek" },
      providerService: { current: () => ({ provider: "deepseek", model: "deepseek-flash" }) },
    } }) as unknown as Session,
    ...options,
  });
  const sessionKey = {};
  const names = () => registry.toLLMTools().map((tool) => tool.function.name);
  try {
    expect(names()).toContain("mcp.docs.search");
    expect(await notice(registry, sessionKey)).toEqual([]);
    // run-turn discovers an MCP tool the user's message names.
    registry.discoverToolNames?.(["mcp.docs.search"]);
    expect(await notice(registry, sessionKey)).toEqual(added(["mcp.docs.search"]));
    connected = false;
    expect(names()).not.toContain("mcp.docs.search");
    expect(await notice(registry, sessionKey)).toEqual([
      expect.objectContaining({ kind: "deferred_tools_delta", addedNames: [], removedNames: ["mcp.docs.search"] }),
    ]);
    // The stable core tools stay out of the notices whatever loads them.
    registry.discoverToolNames?.(["write_stdin", "kill_process", "exec_command"]);
    expect(await notice(registry, sessionKey)).toEqual([]);
  } finally {
    _resetAttachmentTrackingStateForTest(sessionKey);
  }
});
