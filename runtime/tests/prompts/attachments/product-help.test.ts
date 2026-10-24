/**
 * Every head leaves the built-in undo paths out of its fixed prefix and the
 * producer sends them once, with the user message that asks about undoing
 * work.
 */
import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import {
  AGENC_INSTRUCTION_FILE,
  AGENC_UNDO_GUIDANCE,
  AGENC_UNDO_PATHS,
  LIGHT_LOADED_INSTRUCTIONS_NOTE,
} from "../product-help.js";
import { attachmentsToMessages } from "./messages.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { asksAboutInstructionFiles, asksAboutUndo, productHelpProducer } from "./product-help.js";

function makeOpts(text: string, partial?: Partial<GetAttachmentsOptions>): GetAttachmentsOptions {
  return {
    sessionKey: { conversationId: "conv-product-help-test" },
    lightMode: true,
    turnProvenance: { turnId: "turn-1", rootHumanTurn: { turnId: "turn-1", text } },
    userInput: text,
    loadedTools: [],
    messages: [{ role: "user", content: text }],
    permissionContext: { mode: "bypassPermissions" } as ToolPermissionContext,
    cwd: "/tmp/agenc-product-help-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

async function produce(text: string, partial?: Partial<GetAttachmentsOptions>) {
  const opts = makeOpts(text, partial);
  return productHelpProducer(opts, getAttachmentTrackingState(opts.sessionKey));
}

const UNDO_QUESTIONS = [
  "How do I undo what you just did?",
  "can you revert your last change?",
  "Roll back the edits to app.ts please",
  "Is there a rollback if this goes wrong?",
  "Is there a /rewind command?",
  "I want to restore my previous version of the config",
  "how do I go back to the previous state of the code",
  "Can I get my old code back?",
  "where are the checkpoints",
  "wie mache ich das rückgängig?",
  "¿Cómo puedo deshacer el cambio?",
];

// The benchmark prompts (round 4 qb ten, the twoturn follow-up and invoice-kit)
// must not pull the undo paths into the request.
const TASK_PROMPTS = [
  "I'm new to this repo. What does it do, where does execution start, and how does data flow? Name the relevant files and say what units amounts use. Please just explain; don't change files.",
  "The checkout test is failing. Please fix the calculation and cover the edge cases described in the README with tests.",
  "Add an optional --pending flag to the list command so it only shows unfinished tasks. The normal list must keep working. Add pytest tests for this, including an empty list.",
  "Rename prettyName to formatDisplayName throughout the source. Remove the old name completely, keep behavior the same, and update tests to cover all five views.",
  "Build a tiny Node HTTP server with no external dependencies. Put it in server.js; export createServer() and only listen when launched directly. Use PORT (default 3000), including PORT=0. GET /health returns status 200 and JSON {\"ok\":true}. Everything else returns 404 JSON {\"error\":\"not found\"}. Include tests I can run with npm test, and a README showing how to run it.",
  "Our service crashes at startup under the supervisor. The log is in logs/startup.log. Find the cause and fix it so it works regardless of the current directory. Add a regression test.",
  "Please put my existing changes on a new branch called chore/comet-docs and commit them with a sensible message. Leave the working tree clean. Don't add unrelated changes.",
  "From sales.csv, who are our top three customers by revenue? Follow the accounting rules in the README. Give each customer and their exact USD total, highest first. Please don't change any files.",
  "Add an optional --pending flag to the list command so it shows only unfinished tasks. Keep normal list behavior and add pytest tests.",
  "Also document --pending in the README with a runnable example and what it filters.",
  "Extend this board with task completion and filtering. createService() should support complete(id) and list({done}) with exact boolean filtering; list() still returns all. New tasks default to done:false. complete returns the updated task and throws for unknown IDs. add rejects duplicate or empty IDs and invalid titles without changing the store. Returned objects must be copies so callers cannot mutate storage. Update the CLI to accept an optional --pending flag before its JSON argument. Add tests for the service and CLI, and document the API and examples in README.",
  "The tests in this repo are failing. Fix the source code so that npm test passes. Do not modify the tests.",
  "hi",
  "What can AgenC do?",
];

describe("product-help attachment producer", () => {
  test.each(UNDO_QUESTIONS)("sends the undo paths for %j", async (text) => {
    expect(asksAboutUndo(text)).toBe(true);
    expect(await produce(text)).toEqual([{ kind: "product_help", topic: "undo" }]);
  });

  test.each(TASK_PROMPTS)("sends nothing for %j", async (text) => {
    expect(asksAboutUndo(text)).toBe(false);
    expect(asksAboutInstructionFiles(text)).toBe(false);
    expect(await produce(text)).toEqual([]);
  });

  test.each([
    "Add this rule to your instructions file: always run the linter.",
    "What does AGENC.md say about tests?",
    "Should this go in AGENTS.md or CLAUDE.md?",
    "Update the project instructions with the new build command.",
  ])("names AgenC's instruction file for %j", async (text) => {
    expect(await produce(text)).toEqual([{ kind: "product_help", topic: "instructions" }]);
    const [message] = attachmentsToMessages(await produce(text));
    expect(message?.content).toBe(`<system-reminder>\n${AGENC_INSTRUCTION_FILE}\n</system-reminder>`);
  });

  test("loaded instruction files already say where they are: no instruction-file reminder", async () => {
    const text = "What does AGENC.md say about tests? And how do I undo your last edit?";
    // The instructions sent with this request carry them (session/run-turn.ts).
    expect(await produce(text, { lightInstructionFilesLoaded: true }))
      .toEqual([{ kind: "product_help", topic: "undo" }]);
    // An instruction update in the history carries them.
    const update: LLMMessage = { role: "user", content: `<system-reminder>\n${LIGHT_LOADED_INSTRUCTIONS_NOTE}\n</system-reminder>`,
      runtimeOnly: { mergeBoundary: "user_context" } };
    expect(await produce(text, { messages: [update, { role: "user", content: text }] }))
      .toEqual([{ kind: "product_help", topic: "undo" }]);
    // None loaded: the reminder says so.
    expect(await produce(text, { lightInstructionFilesLoaded: false })).toEqual([
      { kind: "product_help", topic: "undo" },
      { kind: "product_help", topic: "instructions" },
    ]);
    expect(AGENC_INSTRUCTION_FILE).toContain("none is loaded in this session");
  });

  test("a message about both sends both topics, each once", async () => {
    const text = "How do I undo your edit to AGENC.md?";
    expect(await produce(text)).toEqual([
      { kind: "product_help", topic: "undo" },
      { kind: "product_help", topic: "instructions" },
    ]);
    const retained: LLMMessage = { role: "user", content: `<system-reminder>\n${AGENC_INSTRUCTION_FILE}\n</system-reminder>`,
      runtimeOnly: { mergeBoundary: "user_context" } };
    expect(await produce(text, { messages: [retained, { role: "user", content: text }] }))
      .toEqual([{ kind: "product_help", topic: "undo" }]);
  });

  test("renders the shared undo paths as one system reminder on the user channel", async () => {
    const [message] = attachmentsToMessages(await produce("how do I undo this?"));
    expect(message).toEqual({
      role: "user",
      content: `<system-reminder>\n${AGENC_UNDO_PATHS}\n</system-reminder>`,
      runtimeOnly: { mergeBoundary: "user_context" },
    });
    // The standard and lean heads keep only the rule to answer such questions without tools.
    expect(AGENC_UNDO_GUIDANCE).not.toContain(AGENC_UNDO_PATHS);
    expect(AGENC_UNDO_GUIDANCE).toContain("undo commands directly without tools");
    for (const fact of ["/rewind", "preview checkpoints", "conversation only", "with or without Git",
      "not every shell command, manual edit, running process", "do not restore anything just to explain it"]) {
      expect(AGENC_UNDO_PATHS).toContain(fact);
    }
  });

  test("every session gets the undo paths, only for the human's own message of this turn", async () => {
    const text = "How do I undo that?";
    expect(await produce(text, { lightMode: false })).toEqual([{ kind: "product_help", topic: "undo" }]);
    expect(await produce(text, { lightMode: undefined })).toEqual([{ kind: "product_help", topic: "undo" }]);
    for (const lightMode of [true, false]) {
      for (const turnProvenance of [
        undefined,
        { turnId: "turn-1", rootHumanTurn: null },
        { turnId: "turn-2", rootHumanTurn: { turnId: "turn-1", text } },
      ]) {
        expect(await produce(text, { lightMode, turnProvenance })).toEqual([]);
      }
    }
  });

  test("standard heads name AGENC.md themselves; Light keeps the instruction-file reminder", async () => {
    const text = "What does AGENC.md say about tests?";
    expect(await produce(text, { lightMode: false })).toEqual([]);
    expect(await produce(text, { lightMode: true })).toEqual([{ kind: "product_help", topic: "instructions" }]);
  });

  test("never sends the paths twice: a retained copy in front of the model suppresses it", async () => {
    const retained: LLMMessage = {
      role: "user",
      content: `<system-reminder>\n${AGENC_UNDO_PATHS}\n</system-reminder>`,
      runtimeOnly: { mergeBoundary: "user_context" },
    };
    const text = "and how do I revert the other file?";
    expect(await produce(text, { messages: [retained, { role: "user", content: text }] })).toEqual([]);
    expect(await produce(text, {
      messages: [{ role: "user", content: [{ type: "text", text: retained.content as string }] }, { role: "user", content: text }],
    })).toEqual([]);
  });
});
