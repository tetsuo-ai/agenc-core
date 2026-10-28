import { expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { recordRetainedAttachments, projectRetainedAttachments } from "../../src/session/attachment-retention.js";
import { capturePromptCacheState, restorePromptCacheState, isPromptCacheState } from "../../src/session/prompt-cache-state.js";
import { parseRolloutLine, serializeRolloutItem, type RolloutItem } from "../../src/session/rollout-item.js";

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
