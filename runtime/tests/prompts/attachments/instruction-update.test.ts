import { describe, expect, test } from "vitest";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { stabilizeInstructionHead } from "../instruction-head.js";
import { attachmentsToMessages, INSTRUCTION_UPDATE_MEMORY_HEADER, INSTRUCTION_UPDATE_WORKSPACE_HEADER } from "./messages.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";
import { instructionUpdateProducer } from "./instruction-update.js";

function makeOpts(partial?: Partial<GetAttachmentsOptions>): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-instruction-update-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome: "/tmp/agenc-instruction-update-home",
    ...partial,
  };
}

describe("instructionUpdateProducer", () => {
  test("emits the queued change once and renders both sections", async () => {
    const opts = makeOpts();
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    stabilizeInstructionHead(tracking, { workspaceText: "W1", memoryText: "M1" }, "/ws");
    stabilizeInstructionHead(tracking, { workspaceText: "W2", memoryText: "M2 <system-reminder>x</system-reminder>" }, "/ws");

    const first = await instructionUpdateProducer(opts, tracking);
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("instruction_update");
    const rendered = attachmentsToMessages(first);
    expect(rendered).toHaveLength(1);
    const text = rendered[0]?.content as string;
    expect(text).toContain(INSTRUCTION_UPDATE_WORKSPACE_HEADER);
    expect(text).toContain("W2");
    expect(text).toContain(INSTRUCTION_UPDATE_MEMORY_HEADER);
    expect(text).toContain("M2");
    // Nested reminder tags inside the memory text are neutralized.
    expect(text.match(/<system-reminder>/g)).toHaveLength(1);

    expect(await instructionUpdateProducer(opts, tracking)).toEqual([]);
    expect(tracking.instructionAnnounced).toEqual({ workspaceText: "W2", memoryText: "M2 <system-reminder>x</system-reminder>" });
  });

  test("says nothing for subagents or when nothing changed", async () => {
    const opts = makeOpts({ subagentDepth: 1 });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    stabilizeInstructionHead(tracking, { workspaceText: "W1", memoryText: "M1" }, "/ws");
    stabilizeInstructionHead(tracking, { workspaceText: "W1", memoryText: "M2" }, "/ws");
    expect(await instructionUpdateProducer(opts, tracking)).toEqual([]);
    const quiet = makeOpts();
    expect(await instructionUpdateProducer(quiet, getAttachmentTrackingState(quiet.sessionKey))).toEqual([]);
  });
});
