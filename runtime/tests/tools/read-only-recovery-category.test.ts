import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function admissionHarness() {
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
    services: { executionAdmission: admission, admissionRequired: true },
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
});
