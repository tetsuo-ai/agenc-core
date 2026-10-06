import { expect, test } from "vitest";
import {
  llmMessageToDurableResponseItem,
  responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import { redactDurableSecrets } from "../../src/session/provider-replay-redaction.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { redactSecretsInValue } from "../../src/secrets/sanitizer.js";

const signature = "A".repeat(84);
const parts = [{
  functionCall: { name: "system.echo", args: { text: "hi" } },
  thoughtSignature: signature,
}];
const replay = {
  version: 2 as const,
  provider: "gemini",
  model: "gemini-3.1-pro",
  content: JSON.stringify(parts),
};

test("preserves opaque Gemini signatures in durable assistant replay positions", () => {
  expect(redactSecretsInValue(signature)).not.toBe(signature);
  const durable = llmMessageToDurableResponseItem({
    role: "assistant", content: "",
    providerReasoningContent: replay.content,
    providerReasoningProvenance: { provider: replay.provider, model: replay.model },
  });
  const restored = responseItemToLlmMessage(JSON.parse(serializeRolloutItem({
    type: "response_item", payload: durable,
  })).payload);
  expect(restored.providerReasoningContent).toBe(replay.content);
  expect(redactDurableSecrets([durable], "history")).toEqual([durable]);
  const source = [{ role: "assistant", provider_reasoning: replay }];
  expect(redactDurableSecrets(source, "source_history")).toEqual(source);
  const compacted = { type: "compacted", payload: { replacementHistory: [durable] } };
  expect(redactDurableSecrets(compacted, "rollout")).toEqual(compacted);
});

test("keeps ordinary redaction for user messages, nested arguments and event payloads", () => {
  const fake = { role: "assistant", providerReasoning: replay };
  const event = { type: "event", payload: { input: fake } };
  expect(redactDurableSecrets(event, "rollout")).toEqual(redactSecretsInValue(event));
  const nested = { role: "assistant", arguments: fake };
  expect(redactDurableSecrets(nested, "response")).toEqual(redactSecretsInValue(nested));
  const user = { ...fake, role: "user" };
  expect(redactDurableSecrets(user, "response")).toEqual(redactSecretsInValue(user));
});

test.each([
  [{ ...parts[0], text: "password = super-secret-password-123" }],
  [{ ...parts[0], functionCall: { name: "system.echo", args: { password: "super-secret-password-123" } } }],
  [{ ...parts[0], thoughtSignature: "password = super-secret-password-123" }],
])("never exempts plaintext secrets beside or inside signatures: %j", (part) => {
  const durable = llmMessageToDurableResponseItem({
    role: "assistant", content: "",
    providerReasoningContent: JSON.stringify([part]),
    providerReasoningProvenance: { provider: replay.provider, model: replay.model },
  });
  expect(durable.providerReasoning).toBeUndefined();
  expect(serializeRolloutItem({ type: "response_item", payload: durable }))
    .not.toContain("super-secret-password-123");
});
