import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildToolRegistry, type ToolRegistry } from "../src/tool-registry.js";
import type { Session } from "../src/session/session.js";
import type { LLMMessage, LLMProvider, LLMTool } from "../src/llm/types.js";
import { buildChatCompletionsRequest } from "../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../src/llm/wire/capability-gating.js";
import { explicitDangerBroker, withExplicitDangerBoundary } from "./helpers/explicit-danger-boundary.js";
import { attachToolRuntimeContext } from "../src/tools/runtimes/context.js";
import { UnifiedExecError, type ExecCommandToolOutput, type UnifiedExecProcessManagerLike } from "../src/unified-exec/types.js";
import { getSessionPermissionInstructions } from "../src/session/permission-instructions.js";
import { createEmptyToolPermissionContext } from "../src/permissions/types.js";
import { capturePromptCacheState, isPromptCacheState, restorePromptCacheState } from "../src/session/prompt-cache-state.js";
import type { RolloutItem } from "../src/session/rollout-item.js";
import { buildFilteredRegistry, TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH } from "../src/agents/run-agent.js";
import { mkCtx } from "./fixtures.js";

function fixture(provider = "deepseek", disabled: string[] = [], model?: string) {
  return buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    toolsConfig: { disabled_tools: disabled },
    getSession: () => ({ services: { provider: { name: provider }, providerService: { current: () => ({ provider, model }) } } }) as Session,
    unifiedExecManager: {
      maxTimeoutMs: Infinity,
      execCommand: vi.fn(async () => ({ stdout: "", stderr: "", output: "", exitCode: null,
        process_id: 71, exit_code: null, wall_time_seconds: 0.001, original_token_count: 0, timedOut: false, truncated: false, durationMs: 1 })),
      writeStdin: vi.fn(), closeAll: vi.fn(async () => {}),
    },
  });
}

function request(registry: ReturnType<typeof fixture>, messages: LLMMessage[]) {
  return buildChatCompletionsRequest({ model: "deepseek-flash", messages,
    tools: registry.toLLMTools(), options: { systemPrompt: "Stable instructions" },
    providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash"),
  });
}

function fields(tools: readonly LLMTool[], name: string): string[] {
  return Object.keys((tools.find(tool => tool.function.name === name)?.function.parameters.properties ?? {}) as object);
}

const initial: LLMMessage[] = [{ role: "user", content: "Build and inspect the app." }];
const continued: LLMMessage[] = [...initial,
  { role: "assistant", content: "Inspect the server.", toolCalls: [{ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' }] },
  { role: "tool", toolCallId: "run", content: "session_id=71" },
];
const COMPACT_EXEC = ["cmd", "workdir", "timeoutMs", "background", "yield_time_ms", "max_output_tokens",
  "sandbox_permissions", "justification", "prefix_rule"];
const COMPACT_STDIN = ["session_id", "chars", "yield_time_ms", "max_output_tokens", "sandbox_permissions", "justification"];
const GIT_DENIED = "fatal: cannot lock ref 'refs/heads/chore/x': unable to create directory for .git/refs/heads/chore/x";
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function execOutput(output: string, exitCode: number): ExecCommandToolOutput {
  return { output, stdout: "", stderr: output, exitCode, exit_code: exitCode, durationMs: 1,
    wall_time_seconds: 0.001, timedOut: false, truncated: false, original_token_count: 3 };
}
function manager(o: ExecCommandToolOutput, writeError?: Error): UnifiedExecProcessManagerLike {
  return {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn(async () => o),
    writeStdin: vi.fn(async () => { if (writeError) throw writeError; return o; }),
    closeAll: vi.fn(async () => {}),
  };
}
function nativeFlash(root: string, m: UnifiedExecProcessManagerLike): ToolRegistry {
  return buildToolRegistry({
    workspaceRoot: root, lightMode: true, requireAdmission: false, unifiedExecManager: m,
    getSession: () => ({ services: { provider: { name: "deepseek" },
      providerService: { current: () => ({ provider: "deepseek", model: "deepseek-flash" }) } } }) as Session,
  });
}
/** A default native DeepSeek Light registry, built as the prompt dump builds it, so its bytes compare with 0.19.29's. */
function dumpRegistry(model: string): ToolRegistry {
  const session = { services: { runtimeOptions: { lightMode: true }, providerEnvironment: {}, provider: { name: "deepseek" },
    providerService: { current: () => ({ provider: "deepseek", model }) } } };
  return buildToolRegistry({ workspaceRoot: "/workspace", lightMode: true, getSession: () => session } as never);
}
function toolCallArgs(root: string, raw: Record<string, unknown>, mode: string, approvalPolicy: string, toolName = "exec_command") {
  const args: Record<string, unknown> = { ...raw };
  attachToolRuntimeContext(args, {
    callId: "c1", toolName, runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0,
    approvalPolicy, requestedSandboxMode: "workspace_write", sandboxMode: "workspace_write",
    approvalResolved: true, rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode, additionalWorkingDirectories: new Map() }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "t1", cwd: root, agencLinuxSandboxExe: "/bin/true" },
    },
  } as never);
  return args;
}

test("native DeepSeek Light starts with the compact core catalog, its process companions and the approval fields", () => {
  const tools = fixture("deepseek", [], "deepseek-flash").toLLMTools();
  expect(tools.map(tool => tool.function.name)).toEqual([
    "system.searchTools", "exec_command", "write_stdin", "kill_process", "FileRead", "Write", "apply_patch",
  ]);
  expect(fields(tools, "exec_command")).toEqual(COMPACT_EXEC);
  expect(fields(tools, "write_stdin")).toEqual(COMPACT_STDIN);
  expect(fields(tools, "kill_process")).toEqual(["session_id", "session_ids", "all"]);
  expect(fields(tools, "FileRead")).toEqual(["file_path", "offset", "limit"]);
  expect(fields(tools, "system.searchTools")).toEqual(["query", "select"]);
  const exec = tools.find(tool => tool.function.name === "exec_command")!.function.description;
  expect(exec).toContain("Other fields (tty, login, shell, detach, additional_permissions) are accepted; system.searchTools select:exec_command loads their schema.");
  expect(JSON.stringify(tools)).not.toContain("additional_permissions\":{");
  // The full core catalog is 6,568 characters on this route (0.19.29); the compact one is 4,301.
  expect(JSON.stringify(tools).length).toBeLessThan(4_400);
});

test("every escalation field the default-mode Light permission text names is in the first exec_command schema", () => {
  const permissionContext = createEmptyToolPermissionContext({ mode: "default" });
  const session = { permissionModeRegistry: { current: () => permissionContext }, services: { runtimeOptions: { lightMode: true } } };
  const ctx = { ...mkCtx({ sandboxPolicy: { value: "workspace_write" } } as never), permissionInstructionsDeferred: true };
  const text = getSessionPermissionInstructions(session as never, ctx, permissionContext);
  const named = ["sandbox_permissions", "justification", "prefix_rule"].filter(field => text.includes(field));
  expect(named).toContain("sandbox_permissions");
  expect(fields(fixture("deepseek", [], "deepseek-flash").toLLMTools(), "exec_command")).toEqual(expect.arrayContaining(named));
});

test("DeepSeek's first yielded process does not expand its cached catalog", async () => {
  const registry = fixture();
  const first = request(registry, initial);
  const result = await registry.tools.find(tool => tool.name === "exec_command")!
    .execute(withExplicitDangerBoundary({ cmd: "pwd" }));
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(result.content).toContain("session_id=71");
  expect([...registry.getDiscoveredToolNames!()].sort()).toEqual(["kill_process", "write_stdin"]);
  const next = request(registry, continued);
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
  expect(JSON.stringify((next.messages as unknown[]).slice(0, (first.messages as unknown[]).length)))
    .toBe(JSON.stringify(first.messages));
  expect(registry.isCoreCatalogExpanded?.()).toBe(false);
});

test("selecting a core schema moves DeepSeek to the full core schemas once, then keeps the catalog stable", () => {
  const registry = fixture("deepseek", [], "deepseek-flash");
  const compact = registry.toLLMTools();
  registry.discoverToolNames?.(["exec_command"]);
  const tools = registry.toLLMTools();
  expect(JSON.stringify(tools)).not.toBe(JSON.stringify(compact));
  expect(tools.map(tool => tool.function.name)).toEqual(compact.map(tool => tool.function.name));
  expect(fields(tools, "exec_command")).toEqual(expect.arrayContaining([...COMPACT_EXEC, "tty", "detach", "additional_permissions"]));
  expect(fields(tools, "write_stdin")).toEqual(expect.arrayContaining([...COMPACT_STDIN, "additional_permissions"]));
  expect(fields(tools, "FileRead")).toEqual(expect.arrayContaining(["pages", "dense_line_numbers"]));
  expect(fields(tools, "system.searchTools")).toEqual(expect.arrayContaining(["maxResults", "includeHidden"]));
  const full = request(registry, initial);
  registry.discoverToolNames?.(["FileRead", "system.searchTools", "write_stdin", "kill_process", "Write", "apply_patch"]);
  const next = request(registry, continued);
  expect(JSON.stringify(next.tools)).toBe(JSON.stringify(full.tools));
  expect(JSON.stringify((next.messages as unknown[]).slice(0, (full.messages as unknown[]).length)))
    .toBe(JSON.stringify(full.messages));
});

test("each compact core schema discovery loads the full core schemas, and companion discovery alone does not", () => {
  for (const selected of ["exec_command", "FileRead", "system.searchTools"]) {
    const registry = fixture("deepseek", [], "deepseek-flash");
    registry.discoverToolNames?.(["write_stdin", "kill_process", "Write", "apply_patch"]);
    expect(fields(registry.toLLMTools(), "exec_command"), selected).not.toContain("additional_permissions");
    registry.discoverToolNames?.([selected]);
    const tools = registry.toLLMTools();
    expect(fields(tools, "exec_command"), selected).toContain("additional_permissions");
    expect(fields(tools, "FileRead"), selected).toContain("pages");
  }
});

test("a system.searchTools selection of any compact core tool switches the catalog, so its loaded answer is true", async () => {
  for (const selected of ["write_stdin", "kill_process", "exec_command", "FileRead", "system.searchTools"]) {
    const registry = fixture("deepseek", [], "deepseek-flash");
    const compact = JSON.stringify(registry.toLLMTools());
    const search = registry.tools.find(tool => tool.name === "system.searchTools")!;
    const result = await search.execute({ select: selected });
    expect(JSON.parse(String(result.content)).loaded, selected).toHaveLength(1);
    const tools = registry.toLLMTools();
    expect(JSON.stringify(tools), selected).not.toBe(compact);
    expect(fields(tools, "write_stdin"), selected).toContain("additional_permissions");
    expect(registry.isCoreCatalogExpanded?.(), selected).toBe(true);
  }
});

describe("real notices on the compact catalog", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cat30-")); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test("a git refusal in a bypass session switches the compact catalog to the one a selection gives", async () => {
    const registry = nativeFlash(root, manager(execOutput(GIT_DENIED, 128)));
    const compact = JSON.stringify(registry.toLLMTools());
    const exec = registry.tools.find(tool => tool.name === "exec_command")!;
    const result = await exec.execute(toolCallArgs(root, { cmd: "git switch -c chore/x" }, "bypassPermissions", "never"));
    expect(String(result.content)).toContain('sandbox_permissions="require_escalated"');
    const afterNotice = JSON.stringify(registry.toLLMTools());
    const selected = nativeFlash(root, manager(execOutput("", 0)));
    selected.discoverToolNames?.(["exec_command"]);
    expect(afterNotice).not.toBe(compact);
    expect(afterNotice).toBe(JSON.stringify(selected.toLLMTools()));
  });

  test("the write_stdin sandbox-profile refusal asks for fields the compact write_stdin presents", async () => {
    const refusal = new UnifiedExecError("write_stdin",
      "write_stdin requires an existing session with a compatible sandbox profile; " +
      "a session started with sandbox_permissions (an escalated or widened sandbox) " +
      "is reached by passing the same sandbox_permissions, and justification, to write_stdin");
    const registry = nativeFlash(root, manager(execOutput("", 0), refusal));
    const stdin = registry.tools.find(tool => tool.name === "write_stdin")!;
    const result = await stdin.execute(toolCallArgs(root, { session_id: 7, chars: "y\n" }, "default", "on_request", "write_stdin"));
    expect(String(result.content)).toContain("passing the same sandbox_permissions");
    expect(fields(registry.toLLMTools(), "write_stdin")).toEqual(expect.arrayContaining(["sandbox_permissions", "justification"]));
  });
});

test("after the switch the catalog is 0.19.29's, byte for byte", () => {
  // sha256 of the native DeepSeek Light tool list of AgenC Core 0.19.29 (e3b738952806) in the prompt dump's
  // construction. Update only with a deliberate change to the full core schemas.
  const pinned: Record<string, string> = {
    "deepseek-flash": "e7082831b7ff5a261445118904433f61f392d04f37fe49ba1b552b0e1328d99e",
    "deepseek-v4-pro": "be878f24bdf7090d20ed1b919ca00964cc496f16e3db0b164fb930132f804214",
  };
  for (const [model, hash] of Object.entries(pinned)) {
    const registry = dumpRegistry(model);
    const fresh = dumpRegistry(model);
    expect(sha256(registry.toLLMTools()), model).not.toBe(hash);
    registry.discoverToolNames?.(["exec_command"]);
    expect(sha256(registry.toLLMTools()), model).toBe(hash);
    expect(sha256(fresh.toExpandedCoreLLMTools?.()), model).toBe(hash);
  }
});

test("eager DeepSeek process schemas obey disabled-tool policy", () => {
  const names = fixture("deepseek", ["write_stdin", "kill_process"]).toLLMTools().map(tool => tool.function.name);
  expect(names).not.toContain("write_stdin");
  expect(names).not.toContain("kill_process");
});

test("other providers retain their measured deferred Light profile", () => {
  const tools = fixture("openai").toLLMTools();
  expect(tools.map(tool => tool.function.name)).not.toContain("write_stdin");
  expect(tools.find(tool => tool.function.name === "exec_command")?.function.parameters.properties)
    .not.toHaveProperty("sandbox_permissions");
  expect(fields(tools, "exec_command")).toEqual(["cmd", "workdir", "timeoutMs", "background"]);
});

test("loading DeepSeek's published core tools is not a deferred load, and discovery survives a provider switch", () => {
  let provider = "deepseek";
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    getSession: () => ({ services: { provider: { name: provider }, providerService: { current: () => ({ provider }) } } }) as Session,
  });
  expect(registry.tools.some(tool => tool.name === "Grep")).toBe(true);
  expect(registry.toLLMTools().map(tool => tool.function.name)).not.toContain("Grep");
  registry.discoverToolNames?.(["write_stdin", "kill_process", "exec_command", "Grep"]);
  expect([...registry.getLoadedDeferredToolNames!()]).toEqual(["Grep"]);
  expect([...registry.getDiscoveredToolNames!()].sort()).toEqual(["Grep", "exec_command", "kill_process", "write_stdin"]);
  provider = "openai";
  expect([...registry.getLoadedDeferredToolNames!()].sort()).toEqual(["Grep", "exec_command", "kill_process", "write_stdin"]);
  expect(registry.toLLMTools().map(tool => tool.function.name)).toEqual(expect.arrayContaining(["write_stdin", "kill_process", "Grep"]));
});

test("a newly loaded tool joins the compact DeepSeek catalog without expanding the core schemas", () => {
  const registry = fixture("deepseek", [], "deepseek-flash");
  const compact = registry.toLLMTools();
  expect(fields(compact, "exec_command")).not.toContain("additional_permissions");
  registry.discoverToolNames?.(["Grep"]);
  const tools = registry.toLLMTools();
  expect(tools.map(tool => tool.function.name)).toContain("Grep");
  expect(JSON.stringify(tools.filter(tool => tool.function.name !== "Grep"))).toBe(JSON.stringify(compact));
  expect([...registry.getLoadedDeferredToolNames!()]).toEqual(["Grep"]);
});

describe("the switch outlives the registry", () => {
  const provider = { name: "deepseek" } as LLMProvider;
  const saved = (sessionKey: object, registry: ToolRegistry): RolloutItem[] =>
    [{ type: "session_state", payload: { promptCache: capturePromptCacheState(sessionKey, provider, registry) } } as RolloutItem];

  test("a resumed or restarted conversation that had switched presents the catalog it last sent", () => {
    const live = fixture("deepseek", [], "deepseek-flash");
    live.discoverToolNames?.(["exec_command"]);
    const lastSent = JSON.stringify(live.toLLMTools());
    const items = saved({}, live);
    expect(items[0]!.type === "session_state" && (items[0]!.payload as { promptCache?: { coreCatalog?: string } }).promptCache?.coreCatalog)
      .toBe("expanded");
    const resumed = fixture("deepseek", [], "deepseek-flash");
    expect(JSON.stringify(resumed.toLLMTools())).not.toBe(lastSent);
    restorePromptCacheState({}, provider, items, resumed);
    expect(JSON.stringify(resumed.toLLMTools())).toBe(lastSent);
    resumed.discoverToolNames?.(["FileRead", "write_stdin", "kill_process"]);
    expect(JSON.stringify(resumed.toLLMTools())).toBe(lastSent);
  });

  test("a conversation that never switched resumes compact", () => {
    const live = fixture("deepseek", [], "deepseek-flash");
    live.discoverToolNames?.(["write_stdin", "kill_process"]);
    const lastSent = JSON.stringify(live.toLLMTools());
    const resumed = fixture("deepseek", [], "deepseek-flash");
    restorePromptCacheState({}, provider, saved({}, live), resumed);
    expect(JSON.stringify(resumed.toLLMTools())).toBe(lastSent);
    expect(resumed.isCoreCatalogExpanded?.()).toBe(false);
  });

  test("the recovery journal accepts the saved switch and nothing else in its place", () => {
    const live = fixture("deepseek", [], "deepseek-flash");
    live.expandCoreCatalog?.();
    const state = capturePromptCacheState({}, provider, live);
    expect(isPromptCacheState(state)).toBe(true);
    expect(isPromptCacheState({ ...state, coreCatalog: "compact" })).toBe(false);
    expect(isPromptCacheState(capturePromptCacheState({}, provider, fixture("deepseek", [], "deepseek-flash")))).toBe(true);
  });
});

describe("a Light child of a compact DeepSeek parent", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cat30-child-")); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const childOf = (parent: ToolRegistry) => buildFilteredRegistry(parent, { childConversationId: "child", lightMode: true,
    unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH });
  const execFields = (registry: ToolRegistry) => fields(registry.toLLMTools(), "exec_command");

  test("starts compact, and its git refusal switches it once to the parent's full core schemas", async () => {
    const parent = nativeFlash(root, manager(execOutput(GIT_DENIED, 128)));
    const child = childOf(parent);
    const spawned = JSON.stringify(child.toLLMTools());
    expect(execFields(child)).toEqual(COMPACT_EXEC);
    const exec = child.tools.find(tool => tool.name === "exec_command")!;
    const result = await exec.execute(toolCallArgs(root, { cmd: "git switch -c chore/x" }, "bypassPermissions", "never"));
    expect(String(result.content)).toContain('sandbox_permissions="require_escalated"');
    expect(execFields(child)).toEqual(expect.arrayContaining(["sandbox_permissions", "additional_permissions", "tty"]));
    expect(JSON.stringify(child.toLLMTools())).not.toBe(spawned);
    const expanded = new Map(parent.toExpandedCoreLLMTools!().map(tool => [tool.function.name, tool]));
    for (const tool of child.toLLMTools()) {
      if (expanded.has(tool.function.name)) expect(JSON.stringify(tool), tool.function.name).toBe(JSON.stringify(expanded.get(tool.function.name)));
    }
    expect(parent.isCoreCatalogExpanded?.()).toBe(false);
    expect(child.isCoreCatalogExpanded?.()).toBe(true);
  });

  test("its selection of exec_command presents tty and detach", async () => {
    const child = childOf(nativeFlash(root, manager(execOutput("", 0))));
    const search = child.tools.find(tool => tool.name === "system.searchTools")!;
    await child.dispatch({ id: "s1", name: search.name, arguments: '{"select":"exec_command"}' });
    expect(execFields(child)).toEqual(expect.arrayContaining(["tty", "detach"]));
  });

  test("its yield and polls keep its catalog, and a child of a parent that had switched starts full", async () => {
    const parent = nativeFlash(root, manager({ ...execOutput("", 0), exitCode: null, exit_code: null, process_id: 9 } as ExecCommandToolOutput));
    const child = childOf(parent);
    const spawned = JSON.stringify(child.toLLMTools());
    const exec = child.tools.find(tool => tool.name === "exec_command")!;
    await exec.execute(toolCallArgs(root, { cmd: "sleep 30", background: true }, "bypassPermissions", "never"));
    expect(JSON.stringify(child.toLLMTools())).toBe(spawned);
    parent.discoverToolNames?.(["exec_command"]);
    const later = childOf(parent);
    expect(execFields(later)).toEqual(expect.arrayContaining(["tty", "detach", "additional_permissions"]));
    expect(later.isCoreCatalogExpanded?.()).toBe(true);
  });
});
