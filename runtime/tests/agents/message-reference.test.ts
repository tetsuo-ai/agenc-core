import { describe, expect, it } from "vitest";
import { MAX_AGENT_MESSAGE_BYTES, resolveAgentMessage } from "../../src/agents/message-reference.js";

const source = (text: string) => ({ currentRootHumanTurn: () => ({ text, turnId: "turn-1" }) });
const ref = (extra = {}) => ({ message_ref: { source: "current_user_message", ...extra } });

describe("agent message references", () => {
  it("copies a long original user message with a constant sized call", () => {
    const text = ' Unicode 🐈 <data> &amp; "quoted" \\ \\n'.repeat(2_000);
    const args = ref();
    expect(JSON.stringify(args).length).toBeLessThan(100);
    expect(resolveAgentMessage(args, source(text))).toBe(text);
  });
  it("selects an exact delimited task without the parent instructions", () => {
    const task = ' \n{"value":"<tag> &amp; 🐈"}\n ';
    expect(resolveAgentMessage(ref({ after: "<task>", before: "</task>" }), source(`Parent instruction<task>${task}</task>End`))).toBe(task);
  });
  it.each([
    [{ source: "another_session" }, "abc"],
    [{ source: "current_user_message", path: "/secret" }, "abc"],
    [{ source: "current_user_message", after: "missing" }, "abc"],
    [{ source: "current_user_message", after: "x" }, "x abc x"],
    [{ source: "current_user_message", after: "end", before: "start" }, "start abc end"],
    [{ source: "current_user_message", after: "" }, "abc"],
  ])("rejects inaccessible or ambiguous references", (reference, text) => {
    expect(() => resolveAgentMessage({ message_ref: reference }, source(text))).toThrow();
  });
  it("does not reuse a previous turn or silently truncate an oversized task", () => {
    expect(() => resolveAgentMessage(ref(), { currentRootHumanTurn: () => null })).toThrow(/no active human/);
    expect(() => resolveAgentMessage(ref(), source("🐈".repeat(MAX_AGENT_MESSAGE_BYTES / 4 + 1)))).toThrow(/256 KiB/);
    expect(() => resolveAgentMessage({ ...ref(), message: "replacement" }, source("task"))).toThrow(/either/);
  });
});
