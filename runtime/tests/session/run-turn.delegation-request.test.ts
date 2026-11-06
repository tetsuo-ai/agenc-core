/**
 * The helper-request reminder reaches the model through a real turn: run-turn answers the orchestrator's
 * catalogIncludes from the session registry, and the reminder sits right before the request it answers.
 */
import { beforeEach, describe, expect, test } from "vitest";

import type { LLMMessage, LLMProvider } from "../../src/llm/types.js";
import { DELEGATION_REQUEST_REMINDER } from "../../src/prompts/attachments/delegation-request.js";
import { catalogIncludesTool } from "../../src/session/run-turn-attachments.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { updateSettingsForSource } from "../../src/utils/settings/settings.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

const HELPERS =
  "Please do these two independent checks in parallel using two helpers.\n" +
  "Helper one: read alpha.txt and report its number.\n" +
  "Helper two: read beta.txt and report its number.\n" +
  "Do not change files. Wait for both helpers and report both results.";
const REMINDER = `<system-reminder>\n${DELEGATION_REQUEST_REMINDER}\n</system-reminder>`;

function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    requiresApproval: false,
    execute: async () => ({ content: "", isError: false }),
  } as unknown as Tool;
}

function registry(catalog: readonly string[], loaded: readonly string[], unavailable: readonly string[] = []): ToolRegistry {
  const tools = catalog.map(tool);
  return {
    tools,
    toLLMTools: () =>
      tools
        .filter((entry) => loaded.includes(entry.name))
        .map((entry) => ({
          type: "function" as const,
          function: { name: entry.name, description: entry.description, parameters: entry.inputSchema },
        })),
    getUnavailableToolNames: () => new Set(unavailable),
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
}

const LIGHT_CATALOG = ["system.searchTools", "exec_command", "FileRead", "spawn_agent", "wait_agent"];
const LIGHT_LOADED = ["system.searchTools", "exec_command", "FileRead"];

async function firstRequest(
  task: string,
  options: { readonly light?: boolean; readonly registry?: ToolRegistry } = {},
): Promise<LLMMessage[]> {
  let seen: LLMMessage[] | undefined;
  const provider: LLMProvider = {
    ...mkProvider(),
    chatStream: async (messages) => {
      seen ??= messages.map((message) => ({ ...message }));
      return {
        content: "done",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    },
  };
  const { session } = mkSession({
    provider,
    registry: options.registry ?? registry(LIGHT_CATALOG, LIGHT_LOADED),
    services: { runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: options.light ?? true }) },
  });
  await drain(session.runTurn(task, { ctx: mkCtx() }));
  return seen ?? [];
}

beforeEach(async () => {
  expect((await updateSettingsForSource("userSettings", { swarmMode: false })).error).toBeNull();
});

describe("runTurn helper-request reminder", () => {
  test("a Light request for helpers carries the reminder right before the request", async () => {
    const messages = await firstRequest(HELPERS);
    const index = messages.findIndex((message) => message.content === REMINDER);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(messages[index + 1]).toMatchObject({ role: "user", content: HELPERS });
    expect(messages.filter((message) => message.content === REMINDER)).toHaveLength(1);
  });

  test.each<[string, string, { readonly light?: boolean; readonly registry?: ToolRegistry }]>([
    ["an ordinary Light request", "Read alpha.txt and beta.txt and report their numbers.", {}],
    ["a standard session", HELPERS, { light: false }],
    ["a catalog without spawn_agent", HELPERS, { registry: registry(LIGHT_LOADED, LIGHT_LOADED) }],
    ["spawn_agent kept only for telemetry", HELPERS, { registry: registry(LIGHT_CATALOG, LIGHT_LOADED, ["spawn_agent"]) }],
    ["spawn_agent already loaded", HELPERS, { registry: registry(LIGHT_CATALOG, [...LIGHT_LOADED, "spawn_agent"]) }],
  ])("%s carries no reminder", async (_label, task, options) => {
    const messages = await firstRequest(task, options);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((message) => String(message.content).includes("This request asks for helpers"))).toBe(false);
  });
});

describe("catalogIncludesTool", () => {
  test("counts registered tools that are offered, loaded or not", () => {
    const tools = registry(LIGHT_CATALOG, LIGHT_LOADED, ["wait_agent"]);
    expect(catalogIncludesTool(tools, "spawn_agent")).toBe(true);
    expect(catalogIncludesTool(tools, "FileRead")).toBe(true);
    expect(catalogIncludesTool(tools, "wait_agent")).toBe(false);
    expect(catalogIncludesTool(tools, "ImagineImage")).toBe(false);
  });
});
