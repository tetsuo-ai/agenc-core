import { describe, expect, test } from "vitest";

import {
  OMITTED_BINARY_CARRIER_TEXT,
  isCanonicalBase64Body,
  omitAlteredBinaryCarriers,
  validatedBinaryCarrierBody,
} from "../../src/llm/content-conversion.js";

const CANONICAL_BODY = "ZmFrZS1wZGY=";
const DATA_URL = `data:image/png;base64,${CANONICAL_BODY}`;

describe("validated binary carriers", () => {
  test("accepts only canonical base64 and both live and durable shapes", () => {
    expect(isCanonicalBase64Body("")).toBe(false);
    expect(isCanonicalBase64Body("abc")).toBe(false);
    expect(isCanonicalBase64Body(CANONICAL_BODY)).toBe(true);
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
