import { describe, expect, it } from "vitest";
import { isContextualUserMessageContent } from "../../src/session/rollout-reconstruction.js";

describe("isContextualUserMessageContent", () => {
  it.each([
    ["AGENC.md instructions", "# AGENC.md instructions for /tmp/work\nUse the repo.\n</INSTRUCTIONS>"],
    ["AGENTS.md instructions", "# AGENTS.md instructions for /tmp/work\nUse the repo.\n</INSTRUCTIONS>"],
    ["environment_context", "<environment_context>\ncwd=/tmp\n</environment_context>"],
    ["skill", "<skill>\nname: review\n</skill>"],
    ["user_shell_command", "<user_shell_command>\nls\n</user_shell_command>"],
    ["turn_aborted", "<turn_aborted>\ninterrupted\n</turn_aborted>"],
    ["subagent_notification", "<subagent_notification>\ndone\n</subagent_notification>"],
    ["session-start-hook", "<session-start-hook>\nok\n</session-start-hook>"],
    ["user-prompt-submit-hook", "<user-prompt-submit-hook>\nok\n</user-prompt-submit-hook>"],
    ["ide_opened_file", "<ide_opened_file>\nsrc/main.ts\n</ide_opened_file>"],
  ])("treats a full %s injection as context, not a user turn", (_label, text) => {
    expect(isContextualUserMessageContent(text)).toBe(true);
    expect(isContextualUserMessageContent(`  ${text.toUpperCase()}\n`)).toBe(true);
  });

  it("requires both markers and ignores ordinary user text", () => {
    expect(isContextualUserMessageContent("<environment_context>\ncwd=/tmp")).toBe(false);
    expect(isContextualUserMessageContent("please continue")).toBe(false);
    expect(isContextualUserMessageContent("")).toBe(false);
    expect(isContextualUserMessageContent([])).toBe(false);
  });

  it("treats a tool-result fragment or any contextual part as context", () => {
    expect(isContextualUserMessageContent([{ type: "tool_result", text: "ok" }])).toBe(true);
    expect(isContextualUserMessageContent([{ type: "function_call_output", text: "ok" }])).toBe(true);
    expect(isContextualUserMessageContent([{ type: "tool_use_result", text: "ok" }])).toBe(true);
    expect(isContextualUserMessageContent([
      { type: "input_text", text: "please continue" },
      { type: "input_text", text: "<skill>\nreview\n</skill>" },
    ])).toBe(true);
    expect(isContextualUserMessageContent([{ type: "input_text", text: "please continue" }])).toBe(false);
  });
});
