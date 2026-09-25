import { expect, it } from "vitest";
import { extractXaiReasoningReplay } from "../../src/llm/wire/responses-xai.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { redactDurableSecrets } from "../../src/session/provider-replay-redaction.js";
import { redactSecretsInValue } from "../../src/secrets/sanitizer.js";
import { encryptedItem, unpaddedGrokReplays } from "../helpers/grok-encrypted-replay.js";

const secret = "hunter2-super-secret-value-2026";
const ciphertext = Buffer.from("opaque encrypted bytes").toString("base64");
const item = { type: "reasoning", id: "rs_1", encrypted_content: ciphertext };
const persist = (items: unknown[], model = "grok-4.7") => llmMessageToDurableResponseItem({ role: "assistant", content: "ok", ...extractXaiReasoningReplay(items, model) });
it("probe 1 redacts plaintext siblings beside valid ciphertext", () => {
  const key = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const result = persist([{ ...item, summary: [{ type: "summary_text", text: `api_key = ${key}` }] }]);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.parse(result.providerReasoning!.content)[0].encrypted_content).toBe(ciphertext);
});
it("probe 2 drops plaintext masquerading as encrypted content", () => {
  const result = persist([{ ...item, encrypted_content: `password = ${secret}` }]);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.providerReasoning).toBeUndefined();
});
it("probe 3 redacts replay-shaped tool arguments in event lines", () => {
  const replay = { version: 2, provider: "grok", content: JSON.stringify([{ ...item, encrypted_content: `password = ${secret}` }]) };
  const result = serializeRolloutItem({ type: "event", payload: { type: "request_permissions", input: { providerReasoning: replay, note: `password = ${secret}` } } } as any);
  expect(result).not.toContain(secret);
});
it("probe 4 redacts secrets in model provenance", () => {
  expect(JSON.stringify(persist([item], `grok-4.7 password = ${secret}`))).not.toContain(secret);
});

it.each(["", "A", "AAAAA", "YR", "YR==", "YQ=", "YQ===", "YQ==\n", "----", "____", "AA-_", "AA!A", "not ciphertext"])("drops the whole replay for noncanonical ciphertext %j", (encrypted_content) => {
  expect(llmMessageToDurableResponseItem({ role: "assistant", content: "ok", providerReasoningContent: JSON.stringify([item, { ...item, encrypted_content }]), providerReasoningProvenance: { provider: "grok", model: "grok-4.7" } }).providerReasoning).toBeUndefined();
});

const largeReplay = { version: 2, provider: "grok", model: "grok-4.7", content: JSON.stringify([encryptedItem]) };
it.each(["providerReasoning", "provider_reasoning"])("does not exempt %s in events, nested arguments or user messages", (key) => {
  const fake = { role: "assistant", [key]: largeReplay };
  const event = { type: "event", payload: { input: fake } };
  expect(redactDurableSecrets(event, "rollout")).toEqual(redactSecretsInValue(event));
  const response = { role: "assistant", arguments: fake };
  expect(redactDurableSecrets(response, "response")).toEqual(redactSecretsInValue(response));
  const user = { role: "user", [key]: largeReplay };
  expect(redactDurableSecrets(user, "response")).toEqual(redactSecretsInValue(user));
  expect(redactSecretsInValue(largeReplay).content).not.toBe(largeReplay.content);
});
it("redacts IDs and unknown fields while preserving ciphertext and benign fields", () => {
  const result = persist([{ ...item, id: `password = ${secret}`, extra: { text: `password = ${secret}`, keep: true } }]);
  expect(JSON.stringify(result)).not.toContain(secret);
  const saved = JSON.parse(result.providerReasoning!.content)[0];
  expect(saved.encrypted_content).toBe(ciphertext);
  expect(saved.extra.keep).toBe(true);
  expect(serializeRolloutItem({ type: "response_item", payload: result })).not.toContain(secret);
});
it("exempts ciphertext only in explicit assistant history positions", () => {
  const response = { role: "assistant", providerReasoning: largeReplay };
  expect(redactDurableSecrets([response], "history")).toEqual([response]);
  const compacted = { type: "compacted", payload: { replacementHistory: [response], input: response } };
  const saved = redactDurableSecrets(compacted, "rollout");
  expect(saved.payload.replacementHistory).toEqual([response]);
  expect(saved.payload.input).toEqual(redactSecretsInValue(response));
});

it.each(unpaddedGrokReplays)("preserves synthetic unpadded $length-character reasoning on durable resume", ({ length, encrypted_content, replay }) => {
  expect(encrypted_content).toHaveLength(length);
  expect(encrypted_content).toMatch(/^[A-Za-z0-9+/]+$/);
  expect(encrypted_content).toMatch(/[+/]/);
  const saved = llmMessageToDurableResponseItem({ role: "assistant", content: "ok", ...replay });
  expect(saved.providerReasoning?.content).toBe(replay.providerReasoningContent);
  expect(responseItemToLlmMessage(saved).providerReasoningContent).toBe(replay.providerReasoningContent);
});
