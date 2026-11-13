import { expect, test, vi } from "vitest";
import type { AgenCConfig } from "../../src/config/schema.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { resolveLightRequest } from "../../src/session/light-request/settings.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { TurnState } from "../../src/session/turn-state.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";
import { createSuccessfulChatResponse } from "../llm/providers/openai-compatible-test-helpers.js";

test.each([
  { system_text: "short", environment_in_system: true },
  { system_text: "minimal", environment_in_system: true },
  { system_text: "short", environment_in_system: false },
  { system_text: "minimal", environment_in_system: false },
] as const)("lean $system_text pins initial permissions and sends mode changes after the prefix, environment_in_system=$environment_in_system", async options => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const model = "deepseek-flash";
  const provider = new DeepSeekProvider({ apiKey: "test-only", model, fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return createSuccessfulChatResponse("permission-cache-fixture")(model, "Done.");
  }) });
  const { session } = mkSession({ provider, model, services: {
    configStore: createTestConfigStore({ base: { light_request: "lean", light_request_options: options } }),
    runtimeOptions: { lightMode: true, nonInteractive: true } as never, providerEnvironment: {},
  } });
  const ctx = mkCtx({ modelProviderId: "deepseek", modelInfo: session.modelInfo, permissionInstructionsDeferred: true });
  const task: LLMMessage = { role: "user", content: "Finish the review." };
  const state = { modelInstructions: "Initial instructions.", messagesForQuery: [task] } as TurnState;
  const send = async (turn: TurnContext = ctx) => {
    const request = buildSamplingRequestContract(state, session, turn, undefined, true);
    await provider.chat([...request.input], buildProviderOptions(request, turn, new AbortController().signal, session));
    return bodies.at(-1)!;
  };
  // Neither preview instructions nor preview permissions may pin the prefix.
  buildSamplingRequestContract({ ...state, modelInstructions: "Preview only." }, session, ctx,
    { ...session.permissionModeRegistry.current(), mode: "plan" });
  const first = await send();
  expect(first.messages.map(message => message.role)).toEqual(["system", "user"]);
  expect(first.messages[1]).toEqual(task);
  const system = first.messages[0]!.content;
  expect(system).toContain("Initial instructions.\n\nPermission mode: default. Sandbox read-only:");
  expect(system).not.toContain("Preview only.");
  expect(system).not.toContain("Permission mode: plan");
  expect((await send()).messages).toEqual(first.messages);

  const expectMode = (body: typeof first, permission: string) => {
    expect(body.messages.filter(message => message.role === "system")).toEqual([first.messages[0]]);
    expect(body.messages.map(message => message.role)).toEqual(["system", "user", "user"]);
    expect(body.messages[1]!.content).toContain(`<system-reminder>\n${permission}`);
    expect(body.messages[1]!.content).toContain("</system-reminder>");
    expect(body.messages[2]).toEqual(task);
  };
  await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "plan" });
  expectMode(await send(), "Permission mode: plan. Sandbox read-only:");
  // Sandbox changes must be visible even when the permission mode is unchanged.
  const writable = { ...ctx, sandboxPolicy: { value: "workspace_write" as const } };
  expectMode(await send(writable), "Permission mode: plan. Sandbox workspace-write:");
  await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "default" });
  expectMode(await send(writable), "Permission mode: default. Sandbox workspace-write:");
  // Runtime context is request-local. Returning to both initial modes needs no reminder.
  expect((await send()).messages).toEqual(first.messages);
});

test.each(["short", "minimal"] as const)("lean %s system bytes survive compaction, resumed turns and refreshed context", async system_text => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const model = "deepseek-flash";
  const provider = new DeepSeekProvider({ apiKey: "test-only", model, fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return createSuccessfulChatResponse("cache-fixture")(model, "Done.");
  }) });
  const configStore = createTestConfigStore({ base: { light_request: "lean", light_request_options: { system_text } } });
  const { session } = mkSession({ provider, model, services: {
    configStore, runtimeOptions: { lightMode: true } as never, providerEnvironment: {},
    providerService: new SessionProviderService({ initialProvider: provider, initialProviderName: "deepseek", initialModel: model,
      environment: {}, sessionId: "cache-fixture" }),
  } });
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session,
    dynamicTools: [{ name: "late_review", description: "Read review context", inputSchema: { type: "object" },
      metadata: { deferred: true }, execute: async () => ({ content: "Review context" }) }],
  });
  Object.assign(session.services, { registry });
  const ctx = mkCtx({ modelProviderId: "deepseek", modelInfo: session.modelInfo, permissionInstructionsDeferred: true });
  const task: LLMMessage = { role: "user", content: "Finish the review." };
  const early: LLMMessage = { role: "user", content: "Initial memory.", runtimeOnly: { attachmentKind: "memory_on_request" } };
  const prompt = async (currentDate: string, memoryPrompt: string) => (await assembleSystemPrompt({
    session, ctx: { ...ctx, currentDate, responseDetailOverride: "low" }, provider: "deepseek", promptIdentity: { provider: "deepseek", model },
    lightProfile: true, deferPermissionInstructions: true, memoryPrompt,
  })).text;
  let state = { modelInstructions: await prompt("2026-11-13", "First memory version."), messagesForQuery: [early, task] } as TurnState;
  // Accounting can inspect a different envelope without committing it.
  buildSamplingRequestContract({ ...state, modelInstructions: "Accounting preview only." }, session, ctx);
  const send = async (mode: "default" | "plan" = "default", responseDetailOverride: "low" | "high" = "low") => {
    const turn = { ...ctx, responseDetailOverride };
    const request = buildSamplingRequestContract(state, session, turn, { ...session.permissionModeRegistry.current(), mode }, true);
    await provider.chat([...request.input], buildProviderOptions(request, turn, new AbortController().signal, session));
    return bodies.at(-1)!;
  };
  const first = await send();
  expect(JSON.stringify(first)).not.toContain('"name":"late_review"');
  const system = first.messages.find(message => message.role === "system")!.content;
  expect(system).not.toContain("# Response Detail");
  expect(JSON.stringify(first.messages.filter(message => message.role !== "system"))).toContain("Concise: keep");
  const summary: LLMMessage = { role: "system", content: "Review of the first file is complete.", runtimeOnly: {
    compactionHistory: { version: 1, kind: "summary", attempt_id: "compact-1", summary_sha256: "a".repeat(64) },
  } };
  // Compaction replaces history and drops the retained attachment's anchor.
  state.messagesForQuery = [summary, task];
  const compacted = await send();
  expect(compacted.messages.find(message => message.role === "system")!.content).toBe(system);
  expect(JSON.stringify(compacted.messages.filter(message => message.role !== "system"))).toContain("Compaction continuation:");
  expect(JSON.stringify(compacted.messages)).toContain("untrusted historical context");
  expect(JSON.stringify(compacted.messages)).toContain(summary.content);

  // A continued/resumed turn has a fresh TurnState, not a fresh Session.
  // Reloaded memory/date/instructions and new skills remain visible outside the prefix.
  registry.discoverToolNames?.(["late_review"]);
  state = { ...state, modelInstructions: await prompt("2026-11-14", "Second memory version."), messagesForQuery: [
    summary, task, { role: "assistant", content: "Reviewed." },
    { role: "user", content: "New skill and memory context.", runtimeOnly: { attachmentKind: "skills" } },
    // Non-leading system-shaped durable history must not be hoisted by the wire adapter either.
    { role: "system", content: "Historical continuation, not policy." },
    { role: "developer", content: "The previous turn was interrupted. Do not repeat completed work.",
      runtimeOnly: { excludeFromDurableHistory: true } },
  ] };
  const resumed = await send("plan", "high");
  expect(resumed.messages.find(message => message.role === "system")!.content).toBe(system);
  const context = JSON.stringify(resumed.messages.filter(message => message.role !== "system"));
  for (const text of ["2026-11-14", "Second memory version.", "New skill and memory context.", "Permission mode: plan", "Historical continuation, not policy.", "Do not repeat completed work.", "Detailed: give thorough"]) {
    expect(context).toContain(text);
  }
  expect(JSON.stringify(resumed)).toContain('"name":"late_review"');
});

test("request options are captured per session and cannot rewrite a running prompt on config reload", () => {
  let config: AgenCConfig = { light_request: "lean" };
  const services = { runtimeOptions: { lightMode: true }, configStore: { current: () => config } };
  const session = { services };
  const initial = resolveLightRequest(session, "deepseek");
  config = { light_request: "lean", light_request_options: { environment_in_system: false, system_text: "short", tool_result_markers: false } };
  expect(resolveLightRequest(session, "deepseek")).toEqual(initial);
  expect(resolveLightRequest({ services }, "deepseek")).toMatchObject(config.light_request_options!);
  expect(resolveLightRequest(session, "openai")).toBeUndefined();
});
