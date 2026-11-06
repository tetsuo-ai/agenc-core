import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  OMITTED_BINARY_CARRIER_TEXT,
  isCanonicalBase64Body,
  omitAlteredBinaryCarriers,
  restoreOmittedBinaryCarriers,
  validatedBinaryCarrierBody,
} from "../../src/llm/content-conversion.js";

const CANONICAL_BODY = "ZmFrZS1wZGY=";
const DATA_URL = `data:image/png;base64,${CANONICAL_BODY}`;

describe("validated binary carriers", () => {
  test("accepts only canonical base64 and both live and durable shapes", () => {
    expect(isCanonicalBase64Body("")).toBe(false);
    expect(isCanonicalBase64Body("abc")).toBe(false);
    expect(isCanonicalBase64Body(CANONICAL_BODY)).toBe(true);
    // Well formed, but the pad bits are not zero: only the round trip rejects it.
    expect(isCanonicalBase64Body("YR==")).toBe(false);
    expect(isCanonicalBase64Body(`${CANONICAL_BODY.slice(0, 4)}[REDACTED]`)).toBe(
      false,
    );

    expect(
      validatedBinaryCarrierBody({
        type: "image_url",
        image_url: { url: DATA_URL },
      }),
    ).toBe(CANONICAL_BODY);
    expect(
      validatedBinaryCarrierBody({
        type: "image",
        source: { url: DATA_URL },
      }),
    ).toBe(CANONICAL_BODY);
    expect(
      validatedBinaryCarrierBody({
        type: "image",
        source: { type: "base64", data: CANONICAL_BODY },
      }),
    ).toBe(CANONICAL_BODY);
    expect(
      validatedBinaryCarrierBody({
        type: "document",
        source: { type: "base64", data: CANONICAL_BODY },
      }),
    ).toBe(CANONICAL_BODY);
  });

  test("does not treat a binary label around plaintext as a carrier", () => {
    const fakeCredential = `sk-${"x".repeat(36)}`;
    expect(
      validatedBinaryCarrierBody({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${fakeCredential}` },
      }),
    ).toBeNull();
    expect(validatedBinaryCarrierBody({ type: "text", text: DATA_URL })).toBeNull();
    expect(validatedBinaryCarrierBody(null)).toBeNull();
  });

  test("omits only altered carriers and keeps redacted sibling text from the target", () => {
    const source = [
      { type: "text", text: `sibling sk-${"x".repeat(36)}` },
      { type: "image_url", image_url: { url: DATA_URL } },
    ];
    const target = [
      { type: "text", text: "sibling [REDACTED_SECRET]" },
      { type: "image_url", image_url: { url: DATA_URL } },
    ];

    const omitted = omitAlteredBinaryCarriers(source, target, () => true);
    expect(omitted.omitted).toBe(true);
    expect(omitted.content).toEqual([
      { type: "text", text: "sibling [REDACTED_SECRET]" },
      { type: "text", text: OMITTED_BINARY_CARRIER_TEXT },
    ]);

    const kept = omitAlteredBinaryCarriers(source, target, () => false);
    expect(kept).toEqual({ content: target, omitted: false });

    expect(
      omitAlteredBinaryCarriers(source, target.slice(0, 1), () => true),
    ).toEqual({ content: target.slice(0, 1), omitted: false });
    expect(omitAlteredBinaryCarriers("text", "other", () => true)).toEqual({
      content: "other",
      omitted: false,
    });
  });
});

describe("restoring a kept message's carriers after compaction", () => {
  const omitted = { type: "text" as const, text: OMITTED_BINARY_CARRIER_TEXT };
  const image = { type: "image_url" as const, image_url: { url: DATA_URL } };
  const toolResult = (id: string, parts: LLMMessage["content"]): LLMMessage =>
    ({ role: "tool", toolCallId: id, toolName: "FileRead", content: parts });

  test("puts back the live carrier of a kept tool result or user message, matched by id", () => {
    const live: LLMMessage[] = [
      toolResult("read-1", [{ type: "text", text: "Read image /a.png" }, image]),
      { role: "user", content: [{ type: "text", text: "Screen" }, image], runtimeOnly: { userMessageId: "user-1" } },
    ];
    const replacement: LLMMessage[] = [
      { role: "user", content: "Summary." },
      toolResult("read-1", [{ type: "text", text: "Read image /a.png" }, omitted]),
      { role: "user", content: [{ type: "text", text: "Screen" }, omitted], runtimeOnly: { responseItemId: "user-1" } },
    ];
    const restored = restoreOmittedBinaryCarriers(replacement, live);
    expect(restored[0]).toBe(replacement[0]);
    expect(restored[1]!.content).toEqual([{ type: "text", text: "Read image /a.png" }, image]);
    expect(restored[2]!.content).toEqual([{ type: "text", text: "Screen" }, image]);
    // Copies, so the replacement never shares a part with the history it replaced.
    expect((restored[1]!.content as unknown[])[1]).not.toBe(image);
    expect(replacement[1]!.content).toEqual([{ type: "text", text: "Read image /a.png" }, omitted]);
  });

  test("restores nothing for an ambiguous id, parts that do not line up, or a live part that is no carrier", () => {
    const kept = toolResult("read-1", [{ type: "text", text: "Read image /a.png" }, omitted]);
    const cases: LLMMessage[][] = [
      [toolResult("read-1", [{ type: "text", text: "x" }, image]), toolResult("read-1", [{ type: "text", text: "y" }, image])],
      [toolResult("read-1", [image, image])],
      [toolResult("read-1", [{ type: "text", text: "Read image /a.png" }])],
      [toolResult("read-1", [{ type: "text", text: "Read image /a.png" }, { type: "text", text: "not an image" }])],
      [toolResult("read-2", [{ type: "text", text: "Read image /a.png" }, image])],
      [{ role: "user", content: [{ type: "text", text: "Read image /a.png" }, image] }],
    ];
    for (const live of cases) expect(restoreOmittedBinaryCarriers([kept], live)[0]).toBe(kept);
  });
});
