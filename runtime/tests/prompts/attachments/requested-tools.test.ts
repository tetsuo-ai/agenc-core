import { describe, expect, test } from "vitest";
import { requestedToolsProducer } from "../../../src/prompts/attachments/requested-tools.js";
import { attachmentsToMessages } from "../../../src/prompts/attachments/messages.js";
import type { GetAttachmentsOptions } from "../../../src/prompts/attachments/orchestrator.js";
import { getAttachmentTrackingState } from "../../../src/session/attachment-state.js";

function options(overrides: Partial<GetAttachmentsOptions> = {}): GetAttachmentsOptions {
  return {
    sessionKey: {}, lightMode: true, userInput: null,
    turnProvenance: { turnId: "human-1", rootHumanTurn: { turnId: "human-1", text: "Use TodoWrite, please." } },
    loadedTools: [], catalogToolNames: ["TodoWrite"], messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/requested-tools", agencHome: "/tmp/requested-tools/home",
    subagentDepth: 0, signal: new AbortController().signal, ...overrides,
  };
}

async function produce(opts: GetAttachmentsOptions) {
  return requestedToolsProducer(opts, getAttachmentTrackingState(opts.sessionKey));
}

describe("user-referenced deferred tool availability", () => {
  test("emits one bounded fact without loading a tool or altering the visible schemas", async () => {
    const opts = options();
    const result = await produce(opts);
    expect(result).toEqual([{ kind: "requested_tools", names: ["TodoWrite"] }]);
    expect(attachmentsToMessages(result)[0]?.content).toContain("Referenced tools available through catalog search: TodoWrite.");
    expect(opts.loadedTools).toEqual([]);
    expect(await produce(opts)).toEqual([]);
  });
  test.each([
    { lightMode: false },
    { catalogToolNames: [] },
    { turnProvenance: { turnId: "synthetic", rootHumanTurn: { turnId: "human-1", text: "TodoWrite" } } },
    { turnProvenance: { turnId: "human-1", rootHumanTurn: null } },
    { loadedTools: [{ type: "function" as const, function: { name: "TodoWrite", description: "", parameters: {} } }] },
    { turnProvenance: { turnId: "human-1", rootHumanTurn: { turnId: "human-1", text: "TodoWriter todowrite" } } },
  ])("does not suggest absent, visible, or nonhuman capabilities: %j", async overrides => {
    expect(await produce(options({ userInput: "TodoWrite", ...overrides }))).toEqual([]);
  });
  test("sorts, deduplicates, bounds and excludes unsafe catalog names", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `tool${i}`);
    const opts = options({ catalogToolNames: [...names.reverse(), "tool0", "<unsafe>"],
      turnProvenance: { turnId: "human-1", rootHumanTurn: { turnId: "human-1", text: names.join(" ") + " <unsafe>" } } });
    expect(await produce(opts)).toEqual([{ kind: "requested_tools", names: [...names].sort().slice(0, 8) }]);
  });
});
