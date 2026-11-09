import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { AgentControl } from "../../src/agents/control.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { runAgent, type RunAgentProgressEvent, type RunAgentResult } from "../../src/agents/run-agent.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { ConfigStore } from "../../src/config/store.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../src/llm/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import type { ResponseItem, RolloutItem } from "../../src/session/rollout-item.js";
import { parseRolloutLine } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { Session, type Event, type SessionOpts, type SessionServices } from "../../src/session/session.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import type { Config, ModelInfo, SessionConfiguration } from "../../src/session/turn-context.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { AsyncQueue } from "../../src/utils/async-queue.js";
import { enterCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

// A forked child (the memory extraction child, a spawn_agent fork) starts from
// its parent's messages. Its compaction maps the history it offers onto the
// records of its own rollout, so the inherited messages must be there: at a
// 32k context window the memory extraction child failed its own compaction
// with "caller history is not an ordered projection of canonical active
// history".

const PARENT = "fork-parent";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function reply(content: string, usage = 64): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: usage, completionTokens: usage, totalTokens: 2 * usage },
    model: "fake-model",
    finishReason: "stop",
  };
}

function isCompactionRequest(messages: readonly LLMMessage[]): boolean {
  const content = messages[0]?.content;
  if (typeof content !== "string") return false;
  try {
    const payload = JSON.parse(content) as { units?: unknown; summaries?: unknown; children?: unknown };
    return payload.units !== undefined || payload.summaries !== undefined || payload.children !== undefined;
  } catch {
    return false;
  }
}

const SUMMARY = JSON.stringify({ narrative: "The inherited exchange, summarized.", facts: [], open_actions: [] });

/** A provider that summarizes compaction requests and finishes everything else. */
function provider(seen: LLMMessage[][], compactions: LLMMessage[][] = [], instructions: string[] = []): LLMProvider {
  const answer = async (messages: LLMMessage[], options?: { readonly systemPrompt?: string }): Promise<LLMResponse> => {
    if (isCompactionRequest(messages)) {
      compactions.push(messages);
      return reply(SUMMARY);
    }
    seen.push(messages);
    instructions.push(options?.systemPrompt ?? "");
    return reply("NOTHING_TO_SAVE");
  };
  return {
    name: "fake",
    chat: vi.fn(async (messages: LLMMessage[], options?: { readonly systemPrompt?: string }) => answer(messages, options)),
    chatStream: vi.fn(async (messages: LLMMessage[], onChunk: (chunk: { content: string; done: boolean }) => void,
      options?: { readonly systemPrompt?: string }) => {
      const response = await answer(messages, options);
      onChunk({ content: response.content, done: true });
      return response;
    }),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as LLMProvider;
}

function sessionConfiguration(cwd: string): SessionConfiguration {
  return {
    cwd,
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "fake-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  } as SessionConfiguration;
}

function config(cwd: string): Config {
  return {
    model: "fake-model",
    cwd,
    features: {},
    multiAgentV2: { usageHintEnabled: false, usageHintText: "", hideSpawnAgentMetadata: false },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  } as unknown as Config;
}

const MODEL_INFO: ModelInfo = {
  slug: "fake-model",
  effectiveContextWindowPercent: 100,
  contextWindow: 131_072,
  maxOutputTokens: 4_096,
  supportedReasoningLevels: [],
  defaultReasoningSummary: "auto",
  truncationPolicy: "off",
  usedFallbackModelMetadata: false,
} as ModelInfo;

/** A parent session with admission and, unless told otherwise, a durable rollout; its children get both. */
function parentSession(seen: LLMMessage[][], modelInfo: ModelInfo = MODEL_INFO, durable = true,
  compactions: LLMMessage[][] = [], instructions: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "agenc-fork-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-fork-project-"));
  mkdirSync(join(cwd, ".git"));
  const kernel = new ExecutionAdmissionKernel({ agencHome: home,
    limits: { global: 20, workspace: 20, session: 20, parent: 20, provider: 20 } });
  const admission = kernel.bindClient({ cwd, scope: { runId: PARENT, sessionId: PARENT, autonomous: false } });
  const configStore = new ConfigStore({ home, cwd });
  enterCanonicalSettingsAuthority(configStore);
  const session = new Session({
    conversationId: PARENT,
    initialState: { sessionConfiguration: sessionConfiguration(cwd), history: [] } as unknown as SessionOpts["initialState"],
    features: {},
    services: {
      permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext()),
      mcpConnectionManager: { setApprovalPolicy: () => {}, setSandboxPolicy: () => {},
        requiredStartupFailures: async () => [] },
      mcpStartupCancellationToken: { cancel: () => {}, isCancelled: () => false },
      provider: provider(seen, compactions, instructions),
      registry: { tools: [], toLLMTools: () => [], dispatch: async () => ({ content: "", isError: false }) } as ToolRegistry,
      hooks: { executeStop: async () => ({}) },
      admissionRequired: false,
      // Admission needs a canonical journal: a session without a rollout runs unadmitted.
      ...(durable ? { executionAdmission: admission } : {}),
      configStore,
      runtimeOptions: resolveAgentRuntimeOptions({}),
    } as unknown as SessionServices,
    jsRepl: { id: "repl-test" },
    config: config(cwd),
    modelInfo,
    eventQueue: new AsyncQueue<Event>(),
  });
  const store = durable
    ? new RolloutStore({ cwd, sessionId: PARENT, agencVersion: "0.2.0", agencHome: home, sessionTempRoot: home })
    : undefined;
  store?.open({ sessionId: PARENT, timestamp: new Date().toISOString(), cwd, originator: "fork-test",
    agencVersion: "0.2.0", model: "fake-model", modelProvider: "fake" });
  if (store !== undefined) session.mountRolloutStore(store);
  cleanups.push(() => {
    store?.close();
    kernel.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return session;
}

async function run(session: Session, initialMessages: LLMMessage[]) {
  const registry = new AgentRegistry();
  const control = new AgentControl({
    session: session as unknown as ConstructorParameters<typeof AgentControl>[0]["session"],
    registry,
  });
  const live = await control.spawn({ parentPath: "/root" });
  const iter = runAgent({ live, parent: session, initialMessages, taskPrompt: "Extract memories." });
  const events: RunAgentProgressEvent[] = [];
  let result: RunAgentResult;
  for (;;) {
    const step = await iter.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  return { live, result, events };
}

function rolloutItems(path: string): RolloutItem[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const item = parseRolloutLine(line);
      return item === null ? [] : [item];
    });
}

/** The parent's last exchange: a question, a tool round sealed by the parent's run, an answer. */
function inheritedMessages(size: number): LLMMessage[] {
  const toolContent = `ls output: ${"f".repeat(size)}`;
  return [
    { role: "user", content: `Please look at the project. ${"q".repeat(size)}` },
    { role: "assistant", content: "", toolCalls: [{ id: "call-inherited", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }] },
    {
      role: "tool", toolCallId: "call-inherited", toolName: "exec_command", content: toolContent,
      runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({ runId: PARENT, toolCallId: "call-inherited",
        content: toolContent }) },
    },
    { role: "assistant", content: `The project has many files. ${"a".repeat(size)}` },
  ];
}

const textOf = (message: LLMMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

test("a forked child writes the history it inherits to its rollout before its first request", async () => {
  const seen: LLMMessage[][] = [];
  const session = parentSession(seen);
  const inherited = inheritedMessages(200);
  const { live, result } = await run(session, [...inherited, { role: "user", content: "Extract memories." }]);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("completed");
  const items = rolloutItems(live.rolloutPath!);
  const childRunId = (items.find((item) => item.type === "session_meta")?.payload as { sessionId?: string }).sessionId;
  const history = items.flatMap((item) => item.type === "response_item" ? [item.payload as ResponseItem] : []);
  // The child's canonical history is what it sends: the inherited exchange,
  // then its task, then its answer.
  expect(history.map((item) => textOf(responseItemToLlmMessage(item)))).toEqual([
    ...inherited.map(textOf), "Extract memories.", "NOTHING_TO_SAVE",
  ]);
  // The inherited tool result is sealed for the child's own run.
  const toolResult = history.find((item) => item.role === "tool");
  expect(toolResult?.toolResultIntegrity?.runId).toBe(childRunId);
  expect(childRunId).not.toBe(PARENT);
  // What the provider received is unchanged: the inherited messages, then the task.
  const request = seen[0]!.filter((message) => message.role !== "system");
  expect(request.slice(0, inherited.length).map(textOf)).toEqual(inherited.map(textOf));
});

test("a forked child whose inherited history fills its context compacts it and finishes", async () => {
  const seen: LLMMessage[][] = [];
  // A full-history fork keeps its parent's model. About 30k tokens of
  // inherited messages are past this compaction limit before the child's
  // first request, as the memory extraction child's batch was at a 32k window.
  const session = parentSession(seen, { ...MODEL_INFO, autoCompactTokenLimit: 16_000 } as ModelInfo);
  const { live, result } = await run(session, [...inheritedMessages(40_000), { role: "user", content: "Extract memories." }]);
  const items = rolloutItems(live.rolloutPath!);
  const warnings = items.flatMap((item) => item.type === "event_msg" && item.payload.msg.type === "warning"
    ? [(item.payload.msg.payload as { message?: string }).message ?? ""] : []);
  expect(warnings.filter((message) => message.includes("ordered projection"))).toEqual([]);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("completed");
  expect(items.filter((item) => item.type === "compaction_committed").length).toBeGreaterThan(0);
  expect(items.some((item) => item.type === "compaction_failed")).toBe(false);
});

test("a forked child without a durable rollout keeps its inherited history in memory, as before", async () => {
  const seen: LLMMessage[][] = [];
  const session = parentSession(seen, MODEL_INFO, false);
  const inherited = inheritedMessages(200);
  const { live, result } = await run(session, [...inherited, { role: "user", content: "Extract memories." }]);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("completed");
  expect(live.rolloutPath).toBeUndefined();
  const request = seen[0]!.filter((message) => message.role !== "system");
  expect(request.slice(0, inherited.length).map(textOf)).toEqual(inherited.map(textOf));
});

test("a fork that kept a tool call without its result keeps its inherited history in memory, as before", async () => {
  // A fork read from the parent's rollout keeps the parent's assistant tool
  // calls and drops their results. The child's rollout would refuse such a
  // history, so the child starts from memory as it always did.
  const seen: LLMMessage[][] = [];
  const session = parentSession(seen);
  const inherited: LLMMessage[] = [
    { role: "user", content: "Please look at the project." },
    { role: "assistant", content: "", toolCalls: [{ id: "call-dropped", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }] },
    { role: "assistant", content: "The project has three files." },
  ];
  const { live, result } = await run(session, [...inherited, { role: "user", content: "Extract memories." }]);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("completed");
  const history = rolloutItems(live.rolloutPath!).flatMap((item) => item.type === "response_item" ? [item.payload as ResponseItem] : []);
  expect(history.map((item) => textOf(responseItemToLlmMessage(item)))).toEqual(["Extract memories.", "NOTHING_TO_SAVE"]);
  const request = seen[0]!.filter((message) => message.role !== "system");
  expect(request.slice(0, inherited.length).map(textOf)).toEqual(inherited.map(textOf));
});

test.each(["system", "developer"] as const)(
  "a fork with a %s message further into its inherited history keeps it in memory, as before",
  async (role) => {
    // The child's rollout takes no system or developer message after the
    // leading ones: such a fork starts from memory, as it always did.
    const seen: LLMMessage[][] = [];
    const instructions: string[] = [];
    const session = parentSession(seen, MODEL_INFO, true, [], instructions);
    const inherited: LLMMessage[] = [
      { role: "user", content: "Please look at the project." },
      { role: "assistant", content: "The project has three files." },
      { role, content: "MID-HISTORY-INSTRUCTION: keep the answers short." },
      { role: "user", content: "And the tests?" },
      { role: "assistant", content: "Two test files." },
    ];
    const { live, result } = await run(session, [...inherited, { role: "user", content: "Extract memories." }]);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    const history = rolloutItems(live.rolloutPath!).flatMap((item) => item.type === "response_item" ? [item.payload as ResponseItem] : []);
    expect(history.map((item) => textOf(responseItemToLlmMessage(item)))).toEqual(["Extract memories.", "NOTHING_TO_SAVE"]);
    expect(readFileSync(live.rolloutPath!, "utf8")).not.toContain("MID-HISTORY-INSTRUCTION");
    const request = [instructions[0] ?? "", ...seen[0]!.map(textOf)].join("\n");
    expect(request).toContain("Please look at the project.");
    expect(request).toContain("MID-HISTORY-INSTRUCTION");
  },
);

test("a forked child whose rollout persistence is suspended stops before its first request", async () => {
  // A session whose rollout persistence is suspended keeps its events out of
  // its rollout (a fork turn on its source session). A child in that state can
  // write neither its inherited history nor its run terminal, so it fails;
  // it must not spend a model request first.
  const seen: LLMMessage[][] = [];
  const session = parentSession(seen);
  const suspended = Session.prototype.isRolloutPersistenceSuspended;
  const spy = vi.spyOn(Session.prototype, "isRolloutPersistenceSuspended").mockImplementation(function (this: Session) {
    return this.conversationId !== PARENT || suspended.call(this);
  });
  cleanups.push(() => spy.mockRestore());
  await expect(run(session, [...inheritedMessages(200), { role: "user", content: "Extract memories." }])).rejects.toThrow();
  expect(seen).toEqual([]);
});

// The session memory child receives its parent's base instructions as a
// system message ahead of the conversation (memory/session/sessionMemory.ts).
// They are instructions, not history: never a stored response item, never
// compaction source, and in the request's system instructions before and
// after a compaction.
const BASE = "BASE-INSTRUCTIONS-MARKER: you are the parent's assistant; keep its rules.";

test("a child's leading system message stays in its system instructions and is never stored", async () => {
  const seen: LLMMessage[][] = [];
  const instructions: string[] = [];
  const session = parentSession(seen, MODEL_INFO, true, [], instructions);
  const { live, result } = await run(session, [{ role: "system", content: BASE }, ...inheritedMessages(200),
    { role: "user", content: "Extract memories." }]);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("completed");
  expect(instructions[0]).toContain(BASE);
  expect(seen[0]!.some((message) => textOf(message).includes("BASE-INSTRUCTIONS-MARKER"))).toBe(false);
  const rollout = readFileSync(live.rolloutPath!, "utf8");
  expect(rollout).not.toContain("BASE-INSTRUCTIONS-MARKER");
  // The rest of the inherited history is in the child's rollout.
  expect(rolloutItems(live.rolloutPath!).filter((item) => item.type === "response_item")).toHaveLength(6);
});

test("a compaction of such a child neither summarizes nor drops its leading system message", async () => {
  const seen: LLMMessage[][] = [];
  const compactions: LLMMessage[][] = [];
  const instructions: string[] = [];
  const session = parentSession(seen, { ...MODEL_INFO, autoCompactTokenLimit: 16_000 } as ModelInfo, true, compactions,
    instructions);
  const { live, result } = await run(session, [{ role: "system", content: BASE }, ...inheritedMessages(40_000),
    { role: "user", content: "Extract memories." }]);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("completed");
  const items = rolloutItems(live.rolloutPath!);
  expect(items.filter((item) => item.type === "compaction_committed").length).toBeGreaterThan(0);
  // Not compaction source, not stored, and still the request's instructions after the compaction.
  expect(compactions.length).toBeGreaterThan(0);
  expect(compactions.some((request) => JSON.stringify(request).includes("BASE-INSTRUCTIONS-MARKER"))).toBe(false);
  expect(readFileSync(live.rolloutPath!, "utf8")).not.toContain("BASE-INSTRUCTIONS-MARKER");
  expect(instructions.length).toBeGreaterThan(0);
  expect(instructions.at(-1)).toContain(BASE);
});
