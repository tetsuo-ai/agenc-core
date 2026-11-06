import { expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { recordRetainedAttachments, projectRetainedAttachments } from "../../src/session/attachment-retention.js";
import { capturePromptCacheState, restorePromptCacheState, isPromptCacheState } from "../../src/session/prompt-cache-state.js";
import { parseRolloutLine, serializeRolloutItem, type RolloutItem } from "../../src/session/rollout-item.js";
import {
  boundContextImagesForProvider,
  contextImageShownBefore,
  EVICTED_IMAGE_TEXT,
  OMITTED_IMAGE_TEXT,
  rememberSentContextImages,
} from "../../src/session/query-image-budget.js";

const provider = (baseURL = "https://api.openai.com/v1") => new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna", baseURL });

test("restored cache has independent containers and keeps only surviving anchors", () => {
  const source = {}, target = {};
  const state = getAttachmentTrackingState(source);
  state.lastDeferredToolsSet = new Set(["FileRead"]);
  state.lastMcpInstructionsMap = new Map([["example", "instructions"]]);
  state.listedSkillNames.add("example");
  const history: LLMMessage[] = [{ role: "user", content: "old" }, { role: "user", content: "kept" }];
  history.forEach((_, index) => recordRetainedAttachments(state.retainedAttachments, history, index, "before", [{
    role: "user", content: `context-${index}`, runtimeOnly: { mergeBoundary: "user_context" },
  }]));
  const item: RolloutItem = { type: "session_state", payload: { promptCache: capturePromptCacheState(source, provider()) } };
  const roundTrip = parseRolloutLine(serializeRolloutItem(item).trim());
  expect(roundTrip).not.toBeNull();
  restorePromptCacheState(target, provider(), [roundTrip!]);
  const restored = getAttachmentTrackingState(target);
  restored.lastDeferredToolsSet!.add("other");
  restored.lastMcpInstructionsMap!.set("other", "new");
  expect(state.lastDeferredToolsSet).toEqual(new Set(["FileRead"]));
  expect(state.lastMcpInstructionsMap.size).toBe(1);
  const projected = projectRetainedAttachments(history.slice(1), restored.retainedAttachments);
  expect(projected.dropped).toBe(1);
  expect(projected.messages.map(message => message.content)).toEqual(["context-1", "kept"]);
  expect(state.retainedAttachments.blocks).toHaveLength(2);
});

test("issued ids restore only to the same provider endpoint and reject malformed identities", () => {
  const original = provider();
  original.restoreFunctionCallItemIds([["call_one", "fc_issued"], ["bad id", "fc_bad"]]);
  const cache = capturePromptCacheState({}, original);
  const item: RolloutItem = { type: "session_state", payload: { promptCache: cache } };
  const same = provider(), other = provider("https://other.example/v1");
  restorePromptCacheState({}, same, [item]);
  restorePromptCacheState({}, other, [item]);
  expect(same.exportFunctionCallItemIds()).toEqual([["call_one", "fc_issued"]]);
  expect(other.exportFunctionCallItemIds()).toEqual([]);
});

test("legacy rollouts and explicit cache clears retain fresh defaults", () => {
  const cache = capturePromptCacheState({}, provider());
  const key = {};
  restorePromptCacheState(key, provider(), [
    { type: "session_state", payload: { promptCache: cache } },
    { type: "session_state", payload: { promptCache: null } },
    { type: "session_state", payload: { userStop: { stopped: false, generation: 0 } } },
  ]);
  expect(getAttachmentTrackingState(key).retainedAttachments.blocks).toEqual([]);
  expect(isPromptCacheState(cache)).toBe(true);
  expect(isPromptCacheState({ ...cache, attachments: {} })).toBe(false);
  expect(isPromptCacheState({ ...cache, version: 9 })).toBe(false);
});

/** A FileRead call and its image result. */
function readImage(id: string): LLMMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "FileRead", arguments: JSON.stringify({ file_path: `/work/${id}.png` }) }] },
    { role: "tool", toolCallId: id, toolName: "FileRead", content: [
      { type: "text", text: `Read image /work/${id}.png` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${id.padEnd(978, "B")}` } },
    ] },
  ];
}

/** The request as a text-only model receives it: the named screen is withheld. */
function withheld(messages: readonly LLMMessage[], id: string): LLMMessage[] {
  return messages.map(message => !Array.isArray(message.content) ? message : { ...message, content: message.content.map(part =>
    part.type === "image_url" && part.image_url.url.includes(id) ? { type: "text" as const, text: "[image withheld]" } : part) });
}

function imageNotes(messages: readonly LLMMessage[]): string[] {
  return messages.flatMap(message => !Array.isArray(message.content) ? [] : message.content.flatMap(part =>
    part.type === "text" && part.text.startsWith("[image omitted") ? [part.text] : []));
}

test("a resumed or restarted session gives an evicted image the note it had before", () => {
  // fx30 review R1: the shown record lived only in the process, so after a resume every evicted note turned
  // neutral once and the first resumed request missed the cache from the first evicted image on.
  const live = {};
  const history: LLMMessage[] = [{ role: "user", content: "Inspect each screen." }];
  for (let index = 0; index < 8; index++) {
    history.push(...readImage(`shot-${index}`));
    const request = boundContextImagesForProvider(history, 6000, "deepseek", contextImageShownBefore(live)).messages;
    // No request carries shot-1: each one withholds it, as for an image the model cannot view.
    rememberSentContextImages(live, withheld(request, "shot-1"), history);
  }
  const before = boundContextImagesForProvider(history, 6000, "deepseek", contextImageShownBefore(live)).messages;
  expect(imageNotes(before)).toEqual([EVICTED_IMAGE_TEXT, OMITTED_IMAGE_TEXT, EVICTED_IMAGE_TEXT, EVICTED_IMAGE_TEXT]);

  const cache = capturePromptCacheState(live, provider());
  expect(cache.shownImageDigests).toHaveLength(7);
  // Digests only: the saved state carries no image bytes.
  expect(JSON.stringify(cache)).not.toContain("BBBB");
  const item = parseRolloutLine(serializeRolloutItem({ type: "session_state", payload: { promptCache: cache } }).trim());
  expect(item).not.toBeNull();
  const resumed = {};
  restorePromptCacheState(resumed, provider(), [item!]);
  const first = boundContextImagesForProvider(history, 6000, "deepseek", contextImageShownBefore(resumed)).messages;
  expect(JSON.stringify(first)).toBe(JSON.stringify(before));
  // The first request after the resume makes the saved record the session's own: the next one repeats the notes.
  rememberSentContextImages(resumed, first, history);
  const next = boundContextImagesForProvider(history, 6000, "deepseek", contextImageShownBefore(resumed)).messages;
  expect(JSON.stringify(next)).toBe(JSON.stringify(before));
  expect(capturePromptCacheState(resumed, provider()).shownImageDigests).toEqual(cache.shownImageDigests);
  expect(isPromptCacheState({ ...cache, shownImageDigests: ["not a digest"] })).toBe(false);
});
