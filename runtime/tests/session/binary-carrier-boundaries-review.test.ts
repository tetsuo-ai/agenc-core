import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { isCanonicalBase64Body } from "../../src/llm/content-conversion.js";
import { redactSecrets, redactSecretsInValue } from "../../src/secrets/sanitizer.js";
import { createToolResultIntegrity, verifyToolResultIntegrity, withPersistedToolResultRepresentation } from "../../src/session/tool-result-integrity.js";
import type { ResponseItem } from "../../src/session/rollout-item.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import { toAgenCRuntimeMessages } from "../../src/session/runtime-message-conversion.js";
import { createCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";
import { isCanonicalBase64Image, syntheticPng } from "../helpers/redacted-inline-image-fixture.js";

describe("independent binary carrier boundary review", () => {
  test("validates five MiB of canonical base64 without a regex stack overflow", () => {
    // Below the six MiB default inline request budget. Zeros cannot match the
    // base58-only heuristic. The bytes need no image decode for this validator.
    const body = "0".repeat(5 * 1024 * 1024);
    expect(isCanonicalBase64Body(body)).toBe(true);
  });

  test("does not crash persistence for a large unchanged canonical carrier", () => {
    const url = `data:image/png;base64,${"0".repeat(5 * 1024 * 1024)}`;
    expect(() => llmMessageToDurableResponseItem({
      role: "user", content: [{ type: "image_url", image_url: { url } }],
    })).not.toThrow();
  });

  test("does not replay an already-redacted image from a historical rollout", () => {
    const url = redactSecrets(syntheticPng(true));
    expect(isCanonicalBase64Image(url)).toBe(false);
    const restored = responseItemToLlmMessage({
      role: "user", content: [{ type: "image_url", image_url: { url } }],
    });
    const images = Array.isArray(restored.content)
      ? restored.content.filter(part => part.type === "image_url") : [];
    for (const image of images) expect(isCanonicalBase64Image(image.image_url.url)).toBe(true);
  });

  test("preserves ordinary remote image URLs during durable replay", () => {
    const url = "https://example.invalid/synthetic-thumbnail.png";
    const item = llmMessageToDurableResponseItem({
      role: "user", content: [{ type: "image_url", image_url: { url } }],
    });
    expect(responseItemToLlmMessage(item).content).toEqual([
      { type: "image_url", image_url: { url } },
    ]);
  });

  test("omitting an image cannot restore unredacted sibling text", () => {
    const fakeCredential = `sk-${"x".repeat(36)}`;
    const item = llmMessageToDurableResponseItem({
      role: "user", content: [
        { type: "text", text: `synthetic sibling ${fakeCredential}` },
        { type: "image_url", image_url: { url: syntheticPng(true) } },
      ],
    });
    // Assert before the later JSONL sink: the converter itself promises the
    // exact redacted representation and must never hand back raw credentials.
    expect(JSON.stringify(item)).not.toContain(fakeCredential);
    expect(JSON.stringify(item)).toContain("synthetic sibling");
  });

  test.each([false, true])("historical tool-media projection respects the existing integrity seal, tampered=%s", (tampered) => {
    const content: LLMMessage["content"] = [
      { type: "text", text: "authenticated synthetic screenshot" },
      { type: "image_url", image_url: { url: syntheticPng(true) } },
    ];
    const oldContent = redactSecretsInValue(content);
    const integrity = withPersistedToolResultRepresentation(
      createToolResultIntegrity({ runId: "legacy-media-run", toolCallId: "legacy-media-call", content }),
      "redacted", oldContent,
    );
    const item: ResponseItem = {
      role: "tool", toolCallId: "legacy-media-call", toolName: "Screenshot",
      content: tampered ? [{ type: "text", text: "forged screenshot result" }, oldContent[1]!] : oldContent,
      toolResultIntegrity: integrity,
    };
    let restored: LLMMessage;
    try { restored = responseItemToLlmMessage(item); }
    catch (error) { if (tampered) return; throw error; }
    const status = verifyToolResultIntegrity({
      integrity: restored.runtimeOnly?.toolResultIntegrity,
      toolCallId: "legacy-media-call", content: restored.content,
    }).status;
    if (tampered) expect(status).not.toBe("valid");
    else expect(status).toBe("valid");
  });

  test.each([false, true])("pins a user attachment after durable omission, collision=%s", async (collision) => {
    const wire: LLMMessage[] = [
      ...Array.from({ length: 18 }, (_, index): LLMMessage => ({
        role: index % 2 ? "assistant" : "user",
        content: Array.from({ length: 180 }, (_, part) => `item-${index}.${part}: result=${part};\n`).join(""),
      })),
      { role: "user", content: [
        { type: "text", text: Array.from({ length: 400 }, (_, index) =>
          `synthetic user attachment ${index}: measured item=${index};\n`).join("") },
        { type: "image_url", image_url: { url: syntheticPng(collision) } },
      ] },
    ];
    const harness = createCompactionTransactionHarness([], {
      sessionId: `user-media-pin-independent-${collision}`, compactionMode: "automatic",
    });
    try {
      for (const message of wire) harness.store.appendRollout({
        type: "response_item", payload: llmMessageToDurableResponseItem(message),
      }, { durable: true });
      const result = await compactConversation(toAgenCRuntimeMessages(wire), harness.context);
      expect(result.transaction).toBeDefined();
      expect(harness.store.readAll().filter(item => item.type === "compaction_committed")).toHaveLength(1);
    } finally { harness.close(); }
  });

  test("a media projection must not hide changed ordinary user text", async () => {
    const wire: LLMMessage[] = [{ role: "user", content: [
      { type: "text", text: "original user instruction" },
      { type: "image_url", image_url: { url: syntheticPng(true) } },
    ] }];
    const harness = createCompactionTransactionHarness([], {
      sessionId: "user-media-pin-tampered-text", compactionMode: "automatic",
    });
    try {
      harness.store.appendRollout({
        type: "response_item", payload: llmMessageToDurableResponseItem(wire[0]!),
      }, { durable: true });
      wire[0] = { role: "user", content: [
        { type: "text", text: "different forged instruction" },
        { type: "image_url", image_url: { url: syntheticPng(true) } },
      ] };
      await expect(compactConversation(toAgenCRuntimeMessages(wire), harness.context))
        .rejects.toMatchObject({ reason: "pin_failed" });
      expect(harness.provider.chat).not.toHaveBeenCalled();
      expect(harness.store.readAll().filter(item => item.type === "compaction_committed")).toHaveLength(0);
    } finally { harness.close(); }
  });
});
