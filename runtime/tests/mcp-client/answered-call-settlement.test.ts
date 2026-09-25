import { describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import {
  assertNoLiveUnknownEffect,
  LiveEffectMutationBlockedError,
} from "../../src/budget/effect-settlement-supervisor.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import { createToolBridge } from "../../src/mcp-client/tools.js";

// A server that answered with a tool result, with or without `isError`, has
// finished the call: its answer is the provider receipt. Only a call whose
// fate is unknown (transport loss, a local timeout or a stop with no answer)
// may lock the session behind /resolve.

// Builds the always-allow lease acquire() resolves with, keyed off the same
// scope the harness hands to the mocked ExecutionAdmissionClient, so the
// reservation and request never drift from the scope they claim to be in.
function allowLease(
  scope: { readonly runId: string; readonly workspaceId: string; readonly sessionId: string },
  input: AdmissionAcquireInput,
): AdmissionLease {
  const step = { runId: scope.runId, stepId: input.stepId };
  return {
    decision: "allow",
    reservation: {
      reservationId: `reservation-${input.stepId}`,
      step,
      reservedCostUsd: input.maxCostUsd ?? 0,
      reservedTokens: input.maxInputTokens + input.maxOutputTokens,
      reservedAt: "2026-09-22T00:00:00.000Z",
    },
    request: {
      step,
      kind: input.kind,
      estimate: {
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        maxCostUsd: input.maxCostUsd,
      },
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      parentScopeId: "turn-1",
      autonomous: false,
    },
    signal: new AbortController().signal,
  };
}

function sessionHarness() {
  const effectEvents: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => effectEvents.push(event));
  const scope = {
    runId: "run-mcp",
    workspaceId: "workspace-1",
    sessionId: "session-mcp",
    autonomous: false,
  };
  const admission = {
    scope,
    acquire: vi.fn(
      async (input: AdmissionAcquireInput): Promise<AdmissionLease> => allowLease(scope, input),
    ),
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({ applied: true as const, outcome: "reconciled" as const })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;
  const session = {
    conversationId: "session-mcp",
    eventLog,
    rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
    emit: (event: Event) => eventLog.emit(event),
    services: {
      executionAdmission: admission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: vi.fn() },
    },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  return { session, effectEvents };
}

async function bridgeFor(
  tool: { name: string; annotations?: Record<string, unknown> },
  callTool: (...args: unknown[]) => Promise<unknown>,
) {
  const client = {
    listTools: async () => ({
      tools: [{ inputSchema: { type: "object", properties: {} }, ...tool }],
    }),
    callTool: vi.fn(callTool),
    close: async () => {},
  };
  const bridge = await createToolBridge(client as never, "lane", undefined, {
    environment: {},
  });
  return { bridge, tool: bridge.tools[0]! };
}

async function runThroughGate(
  harness: ReturnType<typeof sessionHarness>,
  tool: Awaited<ReturnType<typeof bridgeFor>>["tool"],
  callId: string,
) {
  // The live executor hands the admitted call id to the bridge as a
  // non-enumerable argument; mirror that so receipts carry the real id.
  const args: Record<string, unknown> = {};
  Object.defineProperty(args, "__callId", { value: callId, enumerable: false });
  return runAdmittedToolCall({
    session: harness.session,
    turnId: "turn-1",
    callId,
    tool,
    args,
    invoke: async ({ crossEffectBoundary }) => {
      crossEffectBoundary();
      return tool.execute(args);
    },
  });
}

const unknownOutcomes = (events: readonly Event[]) =>
  events.filter((event) => event.msg.type === "effect_unknown_outcome");

describe("MCP call settlement", () => {
  it.each([
    ["an ordinary isError result", { name: "lane_fail" }],
    [
      "an isError result from a readOnlyHint tool",
      { name: "lane_fail_ro", annotations: { readOnlyHint: true } },
    ],
  ])("settles %s from a server that answered without locking the session", async (_label, toolDef) => {
    const harness = sessionHarness();
    const { bridge, tool } = await bridgeFor(toolDef, async () => ({
      isError: true,
      content: [{ type: "text", text: "LANE_FAIL: deliberate failure (test)" }],
    }));
    try {
      const result = await runThroughGate(harness, tool, "call-fail");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("LANE_FAIL");
      expect(result.effectDisposition).toMatchObject({
        disposition: "confirmed_committed",
        evidenceKind: "provider_receipt",
        evidenceRef: `mcp-response:lane:${toolDef.name}:call-fail`,
      });
      expect(unknownOutcomes(harness.effectEvents)).toHaveLength(0);
      expect(() =>
        assertNoLiveUnknownEffect(harness.session, "side-effecting"),
      ).not.toThrow();
    } finally {
      await bridge.dispose();
    }
  });

  it("settles a successful answer with the same server receipt", async () => {
    const harness = sessionHarness();
    const { bridge, tool } = await bridgeFor({ name: "lane_echo" }, async () => ({
      content: [{ type: "text", text: "echo" }],
    }));
    try {
      const result = await runThroughGate(harness, tool, "call-echo");
      expect(result.isError).not.toBe(true);
      expect(result.effectDisposition).toMatchObject({
        disposition: "confirmed_committed",
        evidenceKind: "provider_receipt",
      });
      expect(unknownOutcomes(harness.effectEvents)).toHaveLength(0);
    } finally {
      await bridge.dispose();
    }
  });

  it.each([
    ["a lost connection", () => new McpError(ErrorCode.ConnectionClosed, "Connection closed")],
    ["a local request timeout", () => new McpError(ErrorCode.RequestTimeout, "Request timed out")],
    ["a transport failure", () => new Error("socket hang up after dispatch")],
  ])("keeps %s with no server answer as an unknown outcome", async (_label, makeError) => {
    const harness = sessionHarness();
    const { bridge, tool } = await bridgeFor({ name: "lane_lost" }, async () => {
      throw makeError();
    });
    try {
      const result = await runThroughGate(harness, tool, "call-lost");
      expect(result.isError).toBe(true);
      expect(result.effectDisposition).toBeUndefined();
      expect(unknownOutcomes(harness.effectEvents)).toHaveLength(1);
      expect(() =>
        assertNoLiveUnknownEffect(harness.session, "side-effecting"),
      ).toThrow(LiveEffectMutationBlockedError);
    } finally {
      await bridge.dispose();
    }
  });
});
