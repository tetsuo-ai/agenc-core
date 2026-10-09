import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { runTurn } from "../../src/session/run-turn.js";
import { SessionStore } from "../../src/session/session-store.js";
import { assertOneShotRecoverable, promoteOneShotRun } from "../../src/durability/one-shot-durability.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

async function collect(gen: ReturnType<typeof runTurn>) {
 const events = [];
 for await (const event of gen) events.push(event);
 return events;
}

function setup(fast: boolean, calls: boolean, hooks = {}, completion = false) {
 const execute = vi.fn(async (_args: Record<string, unknown>) => ({ content: "fixture inspected" }));
 const tool = { name: "review_fixture", description: "Read a fixture", isReadOnly: true,
   recoveryCategory: "idempotent" as const, inputSchema: { type: "object" as const }, execute };
 const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false, extraTools: [tool] });
 const provider = mkProvider(); let count = 0;
 const requests: unknown[] = [];
 provider.chatStream = async messages => {
   requests.push(JSON.parse(JSON.stringify(messages)));
   const call = calls && count++ === 0;
   return { content: call ? "" : "Done.", toolCalls: call ? [{ id: "fixture-call", name: tool.name, arguments: "{}" }] : [],
     finishReason: call ? "tool_calls" : "stop", model: "test-model",
     usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
 };
 const f = mkSession({ provider, registry, services: { hooks,
   runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive: true, dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }) } });
 Object.assign(f.session.services, { permissionModeRegistry: new PermissionModeRegistry({
   ...f.session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true }) });
 const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
   config: { ...mkCtx().config, bypassFastMode: fast, completionGate: { mode: completion ? "always" : "never", max_rounds: 1 } } });
 return { ...f, ctx, execute, requests, provider };
}


import { createAllowAdmissionHarness } from "../budget/admission-test-harness.js";
test.each([false, true])("RV successful final response retains model accounting (fast=%s)", async fast => {
 const f = setup(fast, false);
 Object.assign(f.ctx.modelInfo, { maxOutputTokens: 256 });
 const admission = createAllowAdmissionHarness();
 Object.assign(f.session.services, { executionAdmission: admission.admission, admissionRequired: true });
 try {
  const events = await collect(runTurn(f.session, f.ctx, "Say done.", { exactOutput: true }));
  expect(f.requests).toHaveLength(1);
  expect(events.filter(event => event.type === "turn_complete")).toHaveLength(1);
  expect({ acquired: admission.acquire.mock.calls.length, dispatched: admission.markDispatched.mock.calls.length,
   settled: admission.reconcile.mock.calls.length + admission.holdUnknown.mock.calls.length, acknowledged: admission.acknowledgeCompletion.mock.calls.length })
   .toEqual({ acquired: 1, dispatched: 1, settled: 1, acknowledged: 1 });
 } finally { await f.session.shutdown(); }
});


test.each(["reported", "unknown", "provider-failure", "dispatch-failure", "late-cancel"])(
 "fast model lifecycle matches normal settlement: %s", async scenario => {
 const run = async (fast: boolean) => {
  const f = setup(fast, false);
  Object.assign(f.ctx.modelInfo, { maxOutputTokens: 256 });
  Object.assign(f.provider, { name: "ollama" });
  const admission = createAllowAdmissionHarness();
  Object.assign(f.session.services, { executionAdmission: admission.admission, admissionRequired: true });
  const invoke = vi.fn(async (_messages, _onChunk, options) => {
   expect(options.singleWireAttempt).toBe(true);
   expect(options.signal).toBe(admission.leaseController.signal);
   if (scenario === "provider-failure") throw new Error("fixture wire failure");
   if (scenario === "late-cancel") admission.leaseController.abort(new Error("fixture cancelled after send"));
   return { content: "Done.", toolCalls: [], finishReason: "stop" as const, model: "test-model",
     usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11,
       ...(scenario !== "unknown" ? { availability: "reported" as const, provenance: "provider" as const } : {}) } };
  });
  f.provider.chatStream = invoke;
  if (scenario === "dispatch-failure") admission.markDispatched.mockImplementation(() => { throw new Error("fixture dispatch journal failure"); });
  try {
   await collect(runTurn(f.session, f.ctx, "Say done.", { exactOutput: true })).catch(() => []);
   return { sends: invoke.mock.calls.length, acquired: admission.acquire.mock.calls.length,
     dispatches: admission.markDispatched.mock.calls.length, reconciled: admission.reconcile.mock.calls,
     unknown: admission.holdUnknown.mock.calls, voided: admission.voidReservation.mock.calls,
     acknowledged: admission.acknowledgeCompletion.mock.calls.length };
  } finally { await f.session.shutdown(); }
 };
 const normal = await run(false), fast = await run(true);
 expect(fast).toEqual(normal);
 expect(fast.acquired).toBe(1); expect(fast.acknowledged).toBe(1);
 expect(fast.sends).toBe(scenario === "dispatch-failure" ? 0 : 1);
 expect(fast.reconciled.length + fast.unknown.length + fast.voided.length).toBe(1);
 if (scenario === "reported" || scenario === "late-cancel") {
  expect(fast.reconciled[0]?.[1]).toMatchObject({ inputTokens: 10, outputTokens: 1, costUsd: 0 });
 } else if (scenario === "unknown" || scenario === "provider-failure") {
  expect(fast.unknown).toHaveLength(1);
 } else expect(fast.voided).toHaveLength(1);
});
