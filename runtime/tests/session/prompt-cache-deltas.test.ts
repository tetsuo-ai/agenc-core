import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { interruptedTurnNote } from "../../src/prompts/interrupted-turn-note.js";
import { recordRetainedAttachments } from "../../src/session/attachment-retention.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import {
  functionCallItemIdsDeltaItem,
  isPromptCacheDelta,
  restorePromptCacheDeltas,
  retainedAttachmentsDeltaItem,
} from "../../src/session/prompt-cache-deltas.js";
import { capturePromptCacheState } from "../../src/session/prompt-cache-state.js";
import { parseRolloutLine, serializeRolloutItem, type RolloutItem } from "../../src/session/rollout-item.js";

const provider = (baseURL = "https://api.openai.com/v1") =>
  new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna", baseURL });

/** Remember an issued item id the way a response does. */
function issue(target: OpenAIProvider, callId: string, itemId: string): void {
  target.restoreFunctionCallItemIds([[callId, itemId]]);
}

function roundTrip(item: RolloutItem | undefined): RolloutItem {
  const parsed = parseRolloutLine(serializeRolloutItem(item!).trim());
  expect(parsed).not.toBeNull();
  return parsed!;
}

function reminder(text: string): LLMMessage {
  return { role: "user", content: text, runtimeOnly: { mergeBoundary: "user_context" } };
}

describe("prompt cache deltas", () => {
  test("a resume restores the last snapshot, then the blocks and ids written after it", () => {
    const live = {}, resumed = {};
    const issuing = provider();
    const history: LLMMessage[] = [{ role: "user", content: "one" }, { role: "user", content: "two" }];
    const ledger = getAttachmentTrackingState(live).retainedAttachments;
    recordRetainedAttachments(ledger, history, 0, "before", [reminder("at turn end")]);
    issue(issuing, "call_1", "fc_1");
    const snapshot = roundTrip({ type: "session_state", payload: { promptCache: capturePromptCacheState(live, issuing) } });
    // A block and an id from before the snapshot are in it already.
    const stale = roundTrip(retainedAttachmentsDeltaItem([{ ...ledger.blocks[0]!, anchorIndexHint: 1 }]));
    recordRetainedAttachments(ledger, history, 1, "after", [reminder("mid-turn")]);
    issue(issuing, "call_2", "fc_2");
    const block = roundTrip(retainedAttachmentsDeltaItem(ledger.blocks.slice(1)));
    const ids = roundTrip(functionCallItemIdsDeltaItem(issuing, ["call_2", "call_unknown"]));

    const target = provider();
    const items = [stale, snapshot, block, ids];
    restorePromptCacheDeltas(resumed, target, items);
    // Only what follows the snapshot: restorePromptCacheState restores the rest.
    expect(getAttachmentTrackingState(resumed).retainedAttachments.blocks.map((entry) => entry.messages[0]!.content))
      .toEqual(["mid-turn"]);
    expect(target.exportFunctionCallItemIds()).toEqual([["call_2", "fc_2"]]);
  });

  test("without a snapshot every delta applies; another provider's ids do not", () => {
    const resumed = {};
    const issuing = provider();
    issue(issuing, "call_1", "fc_1");
    const ids = roundTrip(functionCallItemIdsDeltaItem(issuing, ["call_1"]));
    const elsewhere = provider("https://example.invalid/v1");
    restorePromptCacheDeltas(resumed, elsewhere, [ids]);
    expect(elsewhere.exportFunctionCallItemIds()).toEqual([]);
    const same = provider();
    restorePromptCacheDeltas(resumed, same, [ids]);
    expect(same.exportFunctionCallItemIds()).toEqual([["call_1", "fc_1"]]);
  });

  test("custom tool call ids travel under their own key; nothing is written without ids or blocks", () => {
    const issuing = provider();
    issue(issuing, "custom:call_patch", "ctc_1");
    const item = functionCallItemIdsDeltaItem(issuing, ["call_patch"]);
    expect(item?.type === "session_state" && item.payload.promptCacheDelta?.functionCallItemIds)
      .toEqual([["custom:call_patch", "ctc_1"]]);
    expect(functionCallItemIdsDeltaItem(issuing, ["call_none"])).toBeUndefined();
    expect(retainedAttachmentsDeltaItem([])).toBeUndefined();
  });

  test("the schema check refuses malformed deltas and blocks it could not restore", () => {
    expect(isPromptCacheDelta({ version: 1 })).toBe(true);
    expect(isPromptCacheDelta({ version: 2 })).toBe(false);
    expect(isPromptCacheDelta({ version: 1, functionCallItemIds: [["call_1"]] })).toBe(false);
    expect(isPromptCacheDelta({ version: 1, retainedAttachments: [{ anchorKey: "k", anchorIndexHint: 0,
      placement: "before", messages: [{ role: "user", content: "no boundary" }] }] })).toBe(false);
    // Such a block is never written, so it cannot make the rollout unreadable.
    expect(retainedAttachmentsDeltaItem([{ anchorKey: "k", anchorIndexHint: 0, placement: "before",
      messages: [{ role: "user", content: "no boundary" }] }])).toBeUndefined();
  });
});

describe("interrupted-turn note on the OpenAI Responses wire", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "Base instructions." },
    { role: "user", content: "Read a.txt." },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "FileRead", arguments: "{}" }] },
    { role: "tool", content: "a", toolCallId: "call_1", toolName: "FileRead" },
    { role: "developer", content: interruptedTurnNote(1) },
  ];

  test("OpenAI sends the note after the history it follows; instructions stay those of the live turn", () => {
    const live = buildOpenAIResponsesRequest({ model: "gpt-6.1-terra", messages: messages.slice(0, 4), tools: [],
      interruptedTurnNoteInPlace: true, chatgptBackend: true });
    const resumed = buildOpenAIResponsesRequest({ model: "gpt-6.1-terra", messages, tools: [],
      interruptedTurnNoteInPlace: true, chatgptBackend: true });
    expect(resumed.instructions).toBe(live.instructions);
    const input = resumed.input as Record<string, unknown>[];
    expect(input.slice(0, -1)).toEqual(live.input);
    expect(input.at(-1)).toEqual({ type: "message", role: "user", content: [{ type: "input_text",
      text: `<system-reminder>\n${interruptedTurnNote(1)}\n</system-reminder>` }] });
  });

  test("other Responses providers keep the note in instructions, byte for byte as before", () => {
    const request = buildOpenAIResponsesRequest({ model: "some-model", messages, tools: [] });
    expect(request.instructions).toBe(`Base instructions.\n\n${interruptedTurnNote(1)}`);
    expect(JSON.stringify(request.input)).not.toContain("interrupted");
  });
});
