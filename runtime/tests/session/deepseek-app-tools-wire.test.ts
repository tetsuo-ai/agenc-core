import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { buildSamplingRequestContract, snapshotSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import type { TurnState } from "../../src/session/turn-state.js";
import type { LLMTool } from "../../src/llm/types.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";
import { createSuccessfulChatResponse } from "../llm/providers/openai-compatible-test-helpers.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

const model = "deepseek-flash";
const toolNames = ["exec_command", "FileRead", "WebSearch", "web_fetch"];
const tools: LLMTool[] = toolNames.map(name => ({ type: "function", function: {
  name, description: name, parameters: { type: "object", properties: {} },
} }));

async function capture(mode: "full" | "lean", appTools: boolean, web: "auto" | "on",
  policy: { deny?: string; ask?: string; allow?: string; scoped?: boolean } = {}, extraction = false,
  editMode?: "tools" | "shell" | "check") {
  let bytes = "";
  const fileRead = createFileReadTool({ allowedPaths: ["/workspace"], deepseekExtraction: extraction });
  const wireTools: LLMTool[] = extraction ? tools.map(tool => tool.function.name === "FileRead"
    ? { type: "function", function: { name: fileRead.name, description: fileRead.description,
        parameters: fileRead.inputSchema as LLMTool["function"]["parameters"] } } : tool) : tools;
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
      ...(editMode === undefined ? {} : { light_request_options: { edit_mode: editMode } }),
      ...(extraction ? { tools_config: { file_read_provider: "deepseek" as const } } : {}),
    } }), providerEnvironment: {},
  } });
  await session.services.configStore.reload();
  Object.assign(session.services, { providerService: new SessionProviderService({
    initialProvider: provider, initialProviderName: "deepseek", initialModel: model, environment: {}, sessionId: "app-tools-wire",
  }), registry: { toLLMTools: () => policy.scoped ? wireTools.slice(0, 2) : wireTools, tools: extraction ? [fileRead] : [], getDiscoveredToolNames: () => new Set(toolNames) } });
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

test("lean App tools use the shell edit default and honor explicit tools mode", async () => {
  const { bytes } = await capture("lean", true, "on");
  expect(bytes).toBe((await capture("lean", true, "on", {}, false, "shell")).bytes);
  const shell = JSON.parse(bytes);
  const toolsMode = JSON.parse((await capture("lean", true, "on", {}, false, "tools")).bytes);
  const execDescription = (body: typeof shell) => body.tools.find(
    (tool: { function?: { name: string } }) => tool.function?.name === "exec_command",
  ).function;
  const shellExec = execDescription(shell);
  const toolsExec = execDescription(toolsMode);
  expect(shellExec.description).toBe(`${toolsExec.description} Create and edit files with shell commands. One command may write files and run the check together.`);
  shellExec.description = toolsExec.description;
  expect(shell).toEqual(toolsMode);
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


test.each(["full", "lean"] as const)("%s retains OCR upload semantics with and without native App tools", async mode => {
  for (const appTools of [false, true]) {
    const { bytes } = await capture(mode, appTools, "on", {}, true);
    const read = JSON.parse(bytes).tools.find((tool: { function?: { name: string } }) => tool.function?.name === "FileRead").function;
    expect(read.description).toContain("DeepSeek OCR");
    expect(read.parameters.properties.extract_text).toMatchObject({ type: "boolean" });
    expect(read.parameters.properties.extract_text.description).toContain("upload the entire file");
  }
});
