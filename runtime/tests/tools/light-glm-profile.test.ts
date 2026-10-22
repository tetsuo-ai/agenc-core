import { expect, test } from "vitest";
import { lightUsesGlmTuning } from "../../src/tools/light-profile.js";
import { LIGHT_GLM_SERVER_CHECKS } from "../../src/tools/light-presentation.js";
import { buildToolRegistry } from "../../src/tool-registry.js";

test.each([
  ["abliteration", "abliterated-model-large-v2", true],
  [" ABLITERATION ", " ABLITERATED-MODEL-LARGE-V2 ", true],
  ["abliteration", "abliterated-model-large", false],
  ["abliteration", "abliterated-model", false],
  ["abliteration", "abliterated-model-large-v2-extra", false],
  ["zai", "abliterated-model-large-v2", false],
  ["openrouter", "z-ai/glm-5.3", false],
  [undefined, "abliterated-model-large-v2", false],
  ["abliteration", undefined, false],
] as const)("Large V2 gate: %s %s", (provider, model, expected) => {
  expect(lightUsesGlmTuning(provider, model)).toBe(expected);
});

test("server guidance survives discovery and a model switch; standard sessions keep their description", () => {
  let model = "abliterated-model-large-v2";
  const session = { services: {
    provider: { name: "abliteration" },
    providerService: { current: () => ({ provider: "abliteration", model }) },
  } } as never;
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, getSession: () => session });
  const description = () => registry.toLLMTools().find(tool => tool.function.name === "exec_command")!.function.description;
  expect(description()).toContain(LIGHT_GLM_SERVER_CHECKS);
  registry.discoverToolNames?.(["exec_command"]);
  expect(description()).toContain(LIGHT_GLM_SERVER_CHECKS);
  model = "abliterated-model-large";
  expect(description()).not.toContain(LIGHT_GLM_SERVER_CHECKS);
  const standard = buildToolRegistry({ workspaceRoot: "/tmp", getSession: () => session });
  expect(standard.toLLMTools().find(tool => tool.function.name === "exec_command")!.function.description)
    .not.toContain(LIGHT_GLM_SERVER_CHECKS);
});
