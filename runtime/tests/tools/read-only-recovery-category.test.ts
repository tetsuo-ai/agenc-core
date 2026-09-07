import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModelFacingTools,
  __setLiveWebFetchDnsAllLookupForTests,
} from "../../src/bin/model-facing-tools.js";
import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import type { ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";

const READ_ONLY_TOOLS = ["web_fetch", "WebSearch", "XSearch", "Sleep"] as const;
const READ_ONLY_EFFECT_EXCEPTIONS: Readonly<Record<string, string>> = {
  AskUserQuestion: "Waits for a user response to an interactive prompt.",
  EnterPlanMode: "Changes the session's permission mode through its workflow controller.",
  Skill: "Records skill invocation in the session's skill history.",
  SendUserMessage: "Emits a user-visible message that a replay could duplicate.",
  "system.searchTools": "Loads deferred tools into the session's advertised catalog.",
};

let workspaceRoot: string;
let registry: ToolRegistry;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-web-recovery-"));
  const modelFacingTools = createModelFacingTools({
    workspaceRoot,
    agencHome: workspaceRoot,
    env: { XAI_API_KEY: "test-xai-key" },
    grokCapabilities: { x_search: true },
    getSession: () => null,
  });
  registry = buildToolRegistry({
    workspaceRoot,
    agencHome: workspaceRoot,
    modelFacingTools,
  });
});

afterEach(async () => {
  __setLiveWebFetchDnsAllLookupForTests(undefined);
  vi.restoreAllMocks();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function registeredTool(name: string): Tool {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing production tool: ${name}`);
  return tool;
}

function admissionHarness(toolPermissionContext = createEmptyToolPermissionContext()) {
  const events: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => events.push(event));
  const acquire = vi.fn(async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
    decision: "allow",
    reservation: {
      reservationId: input.stepId,
      step: { runId: "run-web-recovery", stepId: input.stepId },
      reservedCostUsd: input.maxCostUsd ?? 0,
      reservedTokens: input.maxInputTokens + input.maxOutputTokens,
      reservedAt: "2026-09-07T00:00:00.000Z",
    },
    request: {
      step: { runId: "run-web-recovery", stepId: input.stepId },
      kind: input.kind,
      estimate: {
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        maxCostUsd: input.maxCostUsd,
      },
      workspaceId: workspaceRoot,
      sessionId: "session-web-recovery",
      parentScopeId: "turn-web-recovery",
      autonomous: false,
    },
    signal: new AbortController().signal,
  }));
  const admission = {
    scope: { runId: "run-web-recovery" },
    acquire,
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
  } as unknown as ExecutionAdmissionClient;
  const session = {
    conversationId: "session-web-recovery",
    eventLog,
    emit: (event: Event) => eventLog.emit(event),
    rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
    services: {
      executionAdmission: admission,
      admissionRequired: true,
      permissionModeRegistry: new PermissionModeRegistry(toolPermissionContext),
    },
  } as unknown as Session;
  return { session, events, acquire };
}

describe("production read-only tool recovery", () => {
  it.each(READ_ONLY_TOOLS)("registers %s as idempotent", (name) => {
    expect(registeredTool(name)).toMatchObject({
      isReadOnly: true,
      recoveryCategory: "idempotent",
    });
  });

  it("requires an explained exception for mutation-blocking read-only production tools", () => {
    const exceptions = registry.tools
      .filter((tool) => tool.isReadOnly === true && tool.recoveryCategory !== "idempotent")
      .map((tool) => tool.name)
      .sort();
    expect(exceptions).toEqual(Object.keys(READ_ONLY_EFFECT_EXCEPTIONS).sort());
  });

  it.each(READ_ONLY_TOOLS)("allows a mutation after admitted %s fails", async (name) => {
    const { session, events, acquire } = admissionHarness();
    const timeout = new DOMException("Web request timed out", "TimeoutError");
    await expect(runAdmittedToolCall({
      session,
      turnId: "turn-web-recovery",
      callId: "failed-web-call",
      tool: registeredTool(name),
      args: {},
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        throw timeout;
      },
    })).rejects.toBe(timeout);

    const mutation = vi.fn(async () => ({ content: "mutation completed" }));
    await expect(runAdmittedToolCall({
      session,
      turnId: "turn-web-recovery",
      callId: "later-mutation",
      tool: registeredTool("Write"),
      args: { file_path: join(workspaceRoot, "after.txt"), content: "after" },
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return mutation();
      },
    })).resolves.toEqual({ content: "mutation completed" });
    expect(mutation).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.msg.type === "effect_unknown_outcome")).toBe(false);
  });

  it("allows a real file write after the live web_fetch request times out", async () => {
    const { session, events } = admissionHarness();
    __setLiveWebFetchDnsAllLookupForTests((_hostname, callback) => {
      callback(null, [{ address: "8.8.8.8", family: 4 }]);
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing web-fetch deadline signal");
      signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const web = registeredTool("web_fetch");
    const args = { url: "https://agenc.tech/slow", timeout_ms: 1_000 };
    const result = await runAdmittedToolCall({
      session,
      turnId: "turn-web-recovery",
      callId: "timed-out-web-fetch",
      tool: web,
      args,
      invoke: async ({ signal, crossEffectBoundary }) => {
        crossEffectBoundary();
        return web.execute({ ...args, __abortSignal: signal });
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/timeout|timed out/i);

    const write = registeredTool("Write");
    const filePath = join(workspaceRoot, "after-timeout.txt");
    const writeArgs = { file_path: filePath, content: "mutation after timeout" };
    const written = await runAdmittedToolCall({
      session,
      turnId: "turn-web-recovery",
      callId: "write-after-web-fetch",
      tool: write,
      args: writeArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return write.execute(writeArgs);
      },
    });
    expect(written.isError).not.toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("mutation after timeout");
    expect(events.some((event) => event.msg.type === "effect_unknown_outcome")).toBe(false);
  });

  it.each(["deny", "ask", "allow"] as const)("evaluates web-fetch %s rules before nested dispatch", async (behavior) => {
    const web = registeredTool("web_fetch");
    const args = { url: "https://agenc.tech/restricted" };
    const toolPermissionContext = createEmptyToolPermissionContext({
      [behavior === "deny" ? "alwaysDenyRules" : behavior === "ask" ? "alwaysAskRules" : "alwaysAllowRules"]: {
        localSettings: ["web_fetch(domain:agenc.tech)"],
      },
    });
    const { session, acquire } = admissionHarness(toolPermissionContext);
    const permissionContext = {
      getAppState: () => ({ toolPermissionContext }),
    } as unknown as ToolEvaluatorContext;
    expect(await web.checkPermissions?.(args, permissionContext)).toMatchObject({ behavior });

    __setLiveWebFetchDnsAllLookupForTests((_hostname, callback) => {
      callback(null, [{ address: "8.8.8.8", family: 4 }]);
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("approved response", { headers: { "content-type": "text/plain" } }),
    );
    const liveRegistry = buildToolRegistry({
      workspaceRoot,
      agencHome: workspaceRoot,
      getSession: () => session,
      modelFacingTools: [web],
    });
    const result = await liveRegistry.dispatchCodeModeNestedTool?.({
      id: `nested-web-${behavior}`,
      name: "web_fetch",
      input: args,
    });
    if (behavior === "allow") {
      expect(result?.isError).not.toBe(true);
      expect(result?.content).toContain("approved response");
      expect(acquire).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      return;
    }
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining(behavior === "deny" ? "denied" : "permission"),
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["FileRead", "NotebookRead"])("keeps permitted %s available to nested dispatch", async (name) => {
    const { session } = admissionHarness();
    const filePath = join(workspaceRoot, name === "FileRead" ? "read.txt" : "read.ipynb");
    const content = name === "FileRead"
      ? "permitted file contents"
      : JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [{ cell_type: "markdown", metadata: {}, source: ["permitted file contents"] }],
        });
    await writeFile(filePath, content);
    const liveRegistry = buildToolRegistry({
      workspaceRoot,
      agencHome: workspaceRoot,
      getSession: () => session,
      modelFacingTools: [registeredTool("NotebookRead")],
    });
    const result = await liveRegistry.dispatchCodeModeNestedTool?.({
      id: `nested-${name}`,
      name,
      input: name === "FileRead" ? { file_path: filePath } : { notebook_path: filePath },
    });
    expect(result?.isError).not.toBe(true);
    expect(result?.content).toContain("permitted file contents");
  });

  it("fails closed when a nested tool's permission hook throws", async () => {
    const { session, acquire } = admissionHarness();
    const execute = vi.fn(async () => ({ content: "must not run" }));
    const liveRegistry = buildToolRegistry({
      workspaceRoot,
      getSession: () => session,
      extraTools: [{
        name: "custom.permission-error",
        description: "Read-only tool with a failing permission hook.",
        inputSchema: { type: "object" },
        isReadOnly: true,
        recoveryCategory: "idempotent",
        checkPermissions() { throw new Error("policy unavailable"); },
        execute,
      }],
    });
    const result = await liveRegistry.dispatchCodeModeNestedTool?.({
      id: "nested-permission-error",
      name: "custom.permission-error",
      input: {},
    });
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining("Permission check failed"),
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["WebSearch", "deny"],
    ["WebSearch", "ask"],
    ["XSearch", "deny"],
    ["XSearch", "ask"],
  ] as const)("enforces whole-tool %s %s rules without a permission hook", async (name, behavior) => {
    const { session, acquire } = admissionHarness(createEmptyToolPermissionContext({
      [behavior === "deny" ? "alwaysDenyRules" : "alwaysAskRules"]: {
        localSettings: [name],
      },
    }));
    const search = registeredTool(name);
    expect(search.checkPermissions).toBeUndefined();
    const execute = vi.fn(async () => ({ content: "must not run" }));
    const liveRegistry = buildToolRegistry({
      workspaceRoot,
      getSession: () => session,
      modelFacingTools: [{ ...search, execute }],
    });
    const result = await liveRegistry.dispatchCodeModeNestedTool?.({
      id: `nested-${behavior}-${name}`,
      name,
      input: { query: "example" },
    });
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining(behavior === "deny" ? "denied" : "Permission required"),
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
