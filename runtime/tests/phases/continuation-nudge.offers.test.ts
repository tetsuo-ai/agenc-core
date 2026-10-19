import { describe, expect, test } from "vitest";
import { continuationNudge } from "../../src/phases/continuation-nudge.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { mkCtx, mkSession } from "../fixtures.js";

describe("continuation consent boundary", () => {
  test.each([
    "- Fix problems: paste an error or let me run your program and find the cause.",
    "For example, let me run the tests is something you can ask me.",
    "`Let me run the tests.`",
    "> Now I will create the file.",
    "```text\nNow I will create the file.\n```",
    "Examples:\n\n- Now I will create the file.",
    "Here is how I help: “Now I will create the file.”",
    "Let me run the tests. Which file should I use?",
    "I'm a coding agent — I work inside a folder on your computer (a \"project\") and can actually read, write, and run things, not just talk.\n\nIn plain terms, I can:\n\n- **Explain code** — point me at a file or ask \"what does this project do?\" and I'll walk you through it.\n- **Build small things** — \"make me a webpage that shows a to-do list\" or \"write a script that renames my photos.\"\n- **Fix problems** — paste an error message or let me run your program and find out why it breaks.\n- **Set things up** — installing tools, configuring projects, running tests.\n- **Answer questions** — including \"what even is a folder vs. a repository?\"\n\nHow I work: I look at your files, make edits, and run commands to check my work. You see every step. I ask before anything risky or destructive.\n\nSince you're new, a good first move is to tell me **what you want to end up with** — even vaguely (\"I want a simple personal website\") — and I'll figure out the technical side and explain as I go. There are no bad questions here. What are you hoping to do?"
  ])("does not continue a complete explanation or clarifying question: %s", async (text) => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "hi im new. what can you do? i dont really know how coding works" });
    state.assistantMessages = [{ uuid: "answer", role: "assistant", text, toolCalls: [] }];
    const { session } = mkSession();

    await continuationNudge(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(state.continuationNudgeCount).toBe(0);
    expect(state.messages).toHaveLength(1);
  });

  test.each([
    "I'm AgenC, an autonomous coding agent for software engineering in this workspace.\n\nThis directory is essentially empty except for TASK.md: a notes CLI exercise. I can implement notes.mjs (add/list/show/delete, notes.json storage, black-box node:test tests, and a short README) if you want that next.",
    "I can run the tests next if you'd like.",
    "Would you like me to run the tests next?",
    "If you want, I'll create the file.",
    "Let me run the tests if you approve.",
    "Let me know whether I should run the tests next.",
    "Suggested next step: review the source and tests next.",
    "I'll run the tests after you approve.",
    "With your permission, I'll update the file.",
    "I'll wait until you confirm, then I'll create the file.",
    "Once you give me the go-ahead, I'll run the tests.",
    "I'll update the file pending your approval.",
    "I'll run the tests after your confirmation.",
  ])("does not turn an offer or suggestion into execution: %s", async (text) => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "Inspect the directory and suggest one useful next step." });
    state.assistantMessages = [{ uuid: "offer", role: "assistant", text, toolCalls: [] }];
    const { session } = mkSession();

    await continuationNudge(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(state.continuationNudgeCount).toBe(0);
    expect(state.messages).toHaveLength(1);
  });

  test.each([
    "Now I'll create the file.",
    "I found the bug in checkout.js.\n\nNow I’ll fix the calculation and add tests.",
    "The relevant module is ready. Let me run the tests.",
    "I'll run the tests next.",
    "Let me verify the result. Now I'll run the tests.",
    "Source/eval/shopt/tests incoming sequential tool calls.",
  ])("retains an explicit execution continuation: %s", async (text) => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "Implement and test the feature." });
    state.assistantMessages = [{ uuid: "execution", role: "assistant", text, toolCalls: [] }];
    const { session } = mkSession();

    await continuationNudge(state, ctx, session);

    expect(state.transition?.reason).toBe("continuation_nudge");
    expect(state.continuationNudgeCount).toBe(1);
  });
});
