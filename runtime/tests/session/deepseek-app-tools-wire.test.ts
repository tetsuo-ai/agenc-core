import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { buildSamplingRequestContract, snapshotSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import type { TurnState } from "../../src/session/turn-state.js";
import type { LLMTool } from "../../src/llm/types.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";
import { createSuccessfulChatResponse } from "../llm/providers/openai-compatible-test-helpers.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

const model = "deepseek-flash";
const toolNames = ["exec_command", "FileRead", "WebSearch", "web_fetch"];
const tools: LLMTool[] = toolNames.map(name => ({ type: "function", function: {
  name, description: name, parameters: { type: "object", properties: {} },
} }));

async function capture(mode: "full" | "lean", appTools: boolean, web: "auto" | "on",
  policy: { deny?: string; ask?: string; allow?: string; scoped?: boolean } = {}) {
  let bytes = "";
  const provider = new DeepSeekProvider({ apiKey: "test-only", model,
    fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      bytes = String(init?.body);
      return createSuccessfulChatResponse("app-tools")(model, "Done.");
    }),
  });
  const { session } = mkSession({ provider, model, services: {
    runtimeOptions: { lightMode: true, nonInteractive: true } as never,
    configStore: createTestConfigStore({ base: {
      light_request: mode, web_search: web, providers: { deepseek: { app_tools: appTools } },
    } }), providerEnvironment: {},
  } });
  await session.services.configStore.reload();
  Object.assign(session.services, { providerService: new SessionProviderService({
    initialProvider: provider, initialProviderName: "deepseek", initialModel: model, environment: {}, sessionId: "app-tools-wire",
  }), registry: { toLLMTools: () => policy.scoped ? tools.slice(0, 2) : tools, tools: [], getDiscoveredToolNames: () => new Set(toolNames) } });
  const ctx = mkCtx({ cwd: "/workspace", currentDate: "2026-11-13", modelProviderId: "deepseek",
    modelInfo: { ...session.modelInfo, slug: model }, permissionInstructionsDeferred: true });
  const state = { modelInstructions: "You are a coding agent.", messagesForQuery: [
    { role: "user", content: "Find the official release notes, then inspect README.md." },
  ] } as TurnState;
  const permissions = createEmptyToolPermissionContext({
    alwaysDenyRules: policy.deny ? { userSettings: [policy.deny] } : {},
    alwaysAskRules: policy.ask ? { userSettings: [policy.ask] } : {},
    alwaysAllowRules: policy.allow ? { userSettings: [policy.allow] } : {},
  });
  const request = buildSamplingRequestContract(state, session, ctx, permissions, true);
  const snapshot = snapshotSamplingRequestContract(request);
  const options = buildProviderOptions(snapshot, ctx, new AbortController().signal, session);
  await provider.chat([...snapshot.input], options);
  return { bytes, request, options };
}

test.each(["full", "lean"] as const)("%s session App tools wire snapshot", async mode => {
  const { bytes, request, options } = await capture(mode, true, "on");
  expect(request.deepSeekAppTools).toBe(true);
  expect(options.deepSeekAppTools).toBe(true);
  expect(request.tools.map(tool => tool.function.name)).toEqual(["exec_command", "FileRead"]);
  const body = JSON.parse(bytes);
  expect(body.tools.slice(-2)).toEqual([{ type: "deepseek_web_search" }, { type: "deepseek_read_url" }]);
  expect(body.messages[0].content).toContain("Use deepseek_web_search");
  expect(bytes).toMatchSnapshot();
});

test.each([
  { deny: "WebSearch" }, { ask: "web_fetch" }, { deny: "web_fetch(domain:example.com)" },
  { allow: "web_fetch(domain:example.com)" }, { scoped: true },
])("keeps local policy in control: %j", async policy => {
  const { bytes, request } = await capture("full", true, "on", policy);
  expect(request.deepSeekAppTools).toBeUndefined();
  expect(bytes).not.toContain('"type":"deepseek_web_search"');
});

test.each(["full", "lean"] as const)("%s leaves the existing web path intact when either switch is off", async mode => {
  const noOptIn = await capture(mode, false, "on");
  expect(noOptIn.options).not.toHaveProperty("deepSeekAppTools");
  expect(noOptIn.request.tools.map(tool => tool.function.name)).toContain("WebSearch");
  expect(noOptIn.bytes).not.toContain('"type":"deepseek_web_search"');
  const noWeb = await capture(mode, true, "auto");
  expect(noWeb.options).not.toHaveProperty("deepSeekAppTools");
  expect(noWeb.bytes).not.toContain('"type":"deepseek_web_search"');
});
