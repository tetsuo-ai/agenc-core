import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { describe, expect, it, vi } from "vitest";
import { bypassFastModeEnabled, oneShotFastModeActive, withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { drain, mkCtx, mkSession, mkProvider } from "../fixtures.js";
import type { Session } from "../../src/session/session.js";

it("binds asynchronous authority to a single session and restores nested scopes", async () => {
  expect(oneShotFastModeActive()).toBe(false);
  await withOneShotFastMode(async () => {
    await Promise.resolve();
    expect(oneShotFastModeActive("parent")).toBe(true);
    expect(oneShotFastModeActive("child")).toBe(false);
    await withOneShotFastMode(async () => {
      expect(oneShotFastModeActive("child")).toBe(true);
      expect(oneShotFastModeActive("parent")).toBe(false);
    }, "child");
    expect(oneShotFastModeActive("parent")).toBe(true);
  }, "parent");
  expect(oneShotFastModeActive()).toBe(false);
});

describe("checkpoint scope isolation #3011", () => {
  it.each([false, true])("retains child checkpoints with an inherited parent scope (inherited=%s)", async inherited => {
    const provider = mkProvider();
    let calls = 0;
    provider.chatStream = async () => ({ content: ++calls === 1 ? "checking" : "done", toolCalls: calls === 1 ? [{ id: "child-read", name: "probe", arguments: "{}" }] : [], model: "test-model", finishReason: calls === 1 ? "tool_calls" : "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const registry = { tools: [{ name: "probe", description: "read", inputSchema: { type: "object" }, requiresApproval: false, isReadOnly: true, recoveryCategory: "idempotent", execute: async () => ({ content: "read" }) }], toLLMTools: () => [], dispatch: async () => ({ content: "read" }) } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    session.rolloutStore = { assertCompactionProjectionReady: () => {}, assertToolAdmissionAllowed: () => {}, append: vi.fn(), appendRollout: vi.fn(), rolloutPath: "/tmp/child-checkpoints.jsonl" } as unknown as Session["rolloutStore"];
    const turn = () => drain(runTurn(session, mkCtx(), "child request"));
    if (inherited) await withOneShotFastMode(turn, "parent-session");
    else await turn();
    expect(events.filter(event => event.msg.type === "turn_checkpoint").length).toBeGreaterThan(0);
  });
});


it("cannot re-enter a parent's fast mode using inherited eligibility #3011", async () => {
  const { session } = mkSession();
  Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions,
    dangerouslyBypassApprovalsAndSandbox: true, nonInteractive: true, relaxedOneShot: true,
  } });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" } });
  expect(bypassFastModeEnabled(session, ctx)).toBe(true);
  await withOneShotFastMode(async () => {
    expect(bypassFastModeEnabled(session, ctx)).toBe(false);
  }, "different-parent");
  await withOneShotFastMode(async () => {
    expect(bypassFastModeEnabled(session, ctx)).toBe(true);
  }, String(session.conversationId));
});
