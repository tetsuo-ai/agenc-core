import { expect, test } from "vitest";
import type { LLMTool } from "../../src/llm/types.js";
import { builtTools } from "../../src/session/run-turn-sampling-request.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";

test.each([
  { label: "unbound", provider: undefined, names: ["exec_command", "fixture_lookup"] },
  { label: "native DeepSeek", provider: "deepseek", names: ["exec_command"] },
  { label: "managed", provider: "agenc", names: ["exec_command", "fixture_lookup"] },
  { label: "compatible", provider: "openai-compatible", names: ["exec_command", "fixture_lookup"] },
])("tool discovery keeps the lean profile scoped to the $label provider binding", ({ provider, names }) => {
  const advertised: LLMTool[] = ["exec_command", "fixture_lookup"].map(name => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
  // Registry-only discovery runs before a provider is bound. A model's
  // provider id alone must not activate the native DeepSeek request profile.
  const session = { services: {
    registry: { toLLMTools: () => advertised, tools: [] },
    runtimeOptions: { lightMode: true },
    configStore: { current: () => ({ light_request: "lean" }) },
    ...(provider === undefined ? {} : { provider: { name: provider } }),
  } } as unknown as Session;
  const ctx = { modelProviderId: "deepseek", dynamicTools: [], depth: 0 } as unknown as TurnContext;

  expect(builtTools(session, ctx).map(tool => tool.function.name)).toEqual(names);
});
