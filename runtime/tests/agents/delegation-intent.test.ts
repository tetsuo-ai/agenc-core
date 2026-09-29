import { describe, expect, it } from "vitest";
import { explicitlyRequestsDelegation, requiredDelegationToolChoice } from "../../src/agents/delegation-intent.js";

describe("explicit delegation", () => {
  it.each(["Delegate this task.", "Use subagents to inspect the files.", "Spawn one child to read the report.", "Please delegate this task to a sub-agent.", "Use a worker to inspect the files.", "Your FIRST action must be exactly one spawn_agent call.", "Can you ask a child to compute this?"])("honors %s", text => {
    expect(explicitlyRequestsDelegation(text)).toBe(true);
    expect(requiredDelegationToolChoice({ taskText: text, initialSample: true, depth: 0, planMode: false, toolNames: ["FileRead", "spawn_agent"] })).toEqual({ type: "function", name: "spawn_agent" });
  });
  it.each(["Explain how sub-agents work.", "Use no subagents.", "Spawn zero workers.", "Use exactly zero child agents.", "Use a child process to run the command.", "Spawn a worker thread for parsing.", "Use a child component for the button.", "Use a worker pool for jobs.", "Do not spawn one child.", "Fix the spawn_agent function.", "If useful, delegate this task to a child.", "> Spawn a child.\nExplain that quote.", "```\nSpawn one child.\n```\nExplain that example."])("keeps ordinary chat local: %s", text => {
    expect(explicitlyRequestsDelegation(text)).toBe(false);
  });
  it("does not force replacement workers, children, plans, or unavailable tools", () => {
    const base = { taskText: "Spawn a child.", initialSample: true, depth: 0, planMode: false, toolNames: ["spawn_agent"] };
    for (const override of [{ initialSample: false }, { depth: 1 }, { planMode: true }, { toolNames: [] }, { taskText: undefined }]) {
      expect(requiredDelegationToolChoice({ ...base, ...override })).toBeUndefined();
    }
  });
  it.each([
    "Spawn one child after I approve the plan.",
    "Use subagents if needed.",
    "Delegate this task once I confirm.",
    "Spawn a child only when the plan is approved.",
    "Use a web worker to parse the CSV.",
    "Launch a service worker to cache requests.",
    'Explain this example: "Read the report. Spawn one child. Summarize it."',
    "Explain this example: 'Read the report. Spawn one child. Summarize it.'",
    "Explain this example: “Read the report. Spawn one child. Summarize it.”",
    "Explain `Read the report. Spawn one child. Summarize it.`",
  ])("does not force conditional or quoted instructions: %s", taskText => {
    expect(explicitlyRequestsDelegation(taskText)).toBe(false);
    expect(requiredDelegationToolChoice({ taskText, initialSample: true, depth: 0, planMode: false, toolNames: ["spawn_agent"] })).toBeUndefined();
  });
});
