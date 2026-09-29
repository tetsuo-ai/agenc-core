import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMToolChoice } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

describe.each([false, true])("delegation intent stays with the model (swarm=%s)", swarmMode => {
  it.each([
    "Use a Worker from node:worker_threads to parse the CSV.",
    "Use the children prop to render the button.",
    "Use a React children prop to render the button.",
    "Use subagents only with my approval.",
    "Use two independent agents only with my approval.",
    "Review these independent areas: API and TUI. My approval is required before spawning.",
    "If needed, spawn two independent agents.",
    'Explain "Spawn two independent agents to inspect the files."',
    "Use subagents to inspect the files. My approval is required first.",
    "Get my approval first. Use subagents to inspect the files.",
    "Spawn one child after I approve the plan.",
    "Use subagents if needed.",
    "If the tests fail:\nSpawn a child to investigate the failure.",
    "Spawn a child to investigate the failure\nonly if the tests fail.",
    "Run the tests first. Spawn a child if they fail.",
    'Explain this example: "Read the report. Spawn one child. Summarize it."',
    "Explain this example: 'Read the report. Spawn one child. Summarize it.'",
    "Explain this example: “Read the report. Spawn one child. Summarize it.”",
    "Explain `Read the report. Spawn one child. Summarize it.`",
    "> Spawn a child.\nExplain that quote.",
    "```\nSpawn one child.\n```\nExplain that example.",
    "Use no subagents.",
    "Spawn zero workers.",
    "Do not spawn one child.",
    "Use subagents to inspect the files. Do not use subagents.",
    "Use a background worker to send email.",
    "Use a child process to run the command.",
    "Spawn a worker thread for parsing.",
    "Use a child component for the button.",
    "Use a worker pool for jobs.",
    "Use a web worker to parse the CSV.",
    "Launch a service worker to cache requests.",
    // Even affirmative intent must not select tools or spawn on the model's behalf.
    "Delegate this task.",
    "Use subagents to inspect the files.",
    "Your FIRST action must be exactly one spawn_agent call.",
  ])("does not force tools or spawn automatically: %s", async task => {
    const execute = vi.fn(async () => ({ content: "worker spawned" }));
    const spawn: Tool = {
      name: "spawn_agent", description: "Spawn a bounded worker",
      inputSchema: { type: "object", properties: { task_name: { type: "string" }, message: { type: "string" } }, required: ["task_name", "message"] },
      requiresApproval: false, execute,
    };
    const registry: ToolRegistry = {
      tools: [spawn],
      toLLMTools: () => [{ type: "function", function: { name: spawn.name, description: spawn.description, parameters: spawn.inputSchema } }],
      dispatch: execute,
    };
    const toolChoices: Array<LLMToolChoice | undefined> = [];
    const provider: LLMProvider = {
      ...mkProvider(),
      chatStream: async (_messages, _onChunk, options) => {
        toolChoices.push(options?.toolChoice);
        expect(options?.tools?.some(tool => tool.function.name === "spawn_agent")).toBe(true);
        // Honor a forced tool exactly as a provider would, so the regression
        // detects unintended execution even when tool approval is automatic.
        const forced = options?.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none";
        return {
          content: forced ? "" : "The model chose to respond without delegating.",
          toolCalls: forced ? [{ id: "forced-spawn", name: "spawn_agent", arguments: JSON.stringify({ task_name: "worker", message: "Inspect the files." }) }] : [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "test-model", finishReason: forced ? "tool_calls" : "stop",
        };
      },
    };
    const { session, events } = mkSession({ provider, registry, configStoreBase: { swarmMode } });
    await drain(session.runTurn(task, { ctx: mkCtx() }));
    expect(toolChoices).toEqual([undefined]);
    expect(execute).not.toHaveBeenCalled();
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(true);
  });
});
