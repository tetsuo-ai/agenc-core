import { describe, expect, test } from "vitest";

import { REDACTED_SECRET, redactSecrets, redactSecretsInValue } from "../../src/secrets/sanitizer.js";
import { REAL_SCREENSHOT_CROP_JPEG } from "../helpers/real-screenshot-crop.js";
import { syntheticPng, syntheticPngWithAccessKeyId } from "../helpers/redacted-inline-image-fixture.js";

// The base58 wallet-key rule skips only the base64 body of an image content block whose body is a complete PNG, JPEG,
// GIF or WebP image. Every other rule applies to that body, and every rule applies everywhere else.

// Assembled so secret scanning does not flag the file: 88 base58 characters standing in for an ed25519 secret key.
const BASE58_SECRET_KEY =
  "4wBqpZ" + "M9k7Tj2RhYcVnDxLgUaSeF3bN8pQ6vWmJ5zKtCrXyHd1Ag7uPo2EiBsLn4Qw3Rf6Tz9YvMk8Hb2Cd5Ne";
const body = (url: string) => url.slice(url.indexOf(",") + 1);
const imageUrlBlock = (url: string, extra: Record<string, unknown> = {}) => ({ type: "image_url", image_url: { url, ...extra } });

describe("an image block whose body validates as an image", () => {
  test("a real screenshot keeps its body, which the base58 rule matches as text", () => {
    expect(redactSecrets(REAL_SCREENSHOT_CROP_JPEG)).toContain(REDACTED_SECRET);
    const blocks = [
      imageUrlBlock(REAL_SCREENSHOT_CROP_JPEG),
      { type: "image", source: { url: REAL_SCREENSHOT_CROP_JPEG } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: body(REAL_SCREENSHOT_CROP_JPEG) } },
    ];
    for (const block of blocks) expect(redactSecretsInValue(block)).toEqual(block);
    // Inside a durable message and a rollout-shaped record too.
    const message = { role: "tool", toolCallId: "read", content: [{ type: "text", text: "Read image shot.png" }, blocks[0]] };
    expect(redactSecretsInValue({ type: "response_item", payload: message })).toEqual({ type: "response_item", payload: message });
  });

  test("a generated PNG whose only match is a base58 run keeps its body", () => {
    const url = syntheticPng(true);
    expect(redactSecrets(url)).toContain(REDACTED_SECRET);
    expect(redactSecretsInValue(imageUrlBlock(url))).toEqual(imageUrlBlock(url));
  });

  test("every other rule still applies to the body", () => {
    const url = syntheticPngWithAccessKeyId();
    const redacted = redactSecretsInValue(imageUrlBlock(url));
    expect(redacted.image_url.url).toContain(REDACTED_SECRET);
    expect(redacted.image_url.url).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
});

describe("a base58 key is still redacted", () => {
  test("in text", () => {
    expect(redactSecrets(`wallet ${BASE58_SECRET_KEY}`)).toBe(`wallet ${REDACTED_SECRET}`);
    expect(redactSecretsInValue({ note: `exported ${BASE58_SECRET_KEY}` })).toEqual({ note: `exported ${REDACTED_SECRET}` });
  });

  test("in a caption next to an image", () => {
    const content = [{ type: "text", text: `caption ${BASE58_SECRET_KEY}` }, imageUrlBlock(REAL_SCREENSHOT_CROP_JPEG)];
    expect(redactSecretsInValue(content)).toEqual([
      { type: "text", text: `caption ${REDACTED_SECRET}` }, imageUrlBlock(REAL_SCREENSHOT_CROP_JPEG),
    ]);
  });

  test("in a result that is not an image", () => {
    const result = { role: "tool", toolCallId: "cat", content: [{ type: "text", text: BASE58_SECRET_KEY }] };
    expect(JSON.stringify(redactSecretsInValue(result))).not.toContain(BASE58_SECRET_KEY);
    const asString = { role: "tool", toolCallId: "cat", content: `key: ${BASE58_SECRET_KEY}` };
    expect(JSON.stringify(redactSecretsInValue(asString))).not.toContain(BASE58_SECRET_KEY);
  });

  test("in an image block's other fields", () => {
    const blocks = [
      imageUrlBlock(REAL_SCREENSHOT_CROP_JPEG, { detail: BASE58_SECRET_KEY }),
      { ...imageUrlBlock(REAL_SCREENSHOT_CROP_JPEG), alt: BASE58_SECRET_KEY },
      { type: "image", source: { type: "base64", media_type: BASE58_SECRET_KEY, data: body(REAL_SCREENSHOT_CROP_JPEG) } },
      { type: "image", title: BASE58_SECRET_KEY, source: { url: REAL_SCREENSHOT_CROP_JPEG } },
    ];
    for (const block of blocks) {
      const redacted = JSON.stringify(redactSecretsInValue(block));
      expect(redacted).not.toContain(BASE58_SECRET_KEY);
      expect(redacted).toContain(body(REAL_SCREENSHOT_CROP_JPEG));
    }
  });

  test("in an image block whose body is not a valid image", () => {
    const notAnImage = `data:image/png;base64,0000${BASE58_SECRET_KEY}0000`;
    // A PNG cut before its end chunk: the base58 run is still there, but the body is no complete image.
    const truncated = syntheticPng(true).slice(0, -24);
    for (const url of [notAnImage, truncated]) {
      expect(JSON.stringify(redactSecretsInValue(imageUrlBlock(url)))).toContain(REDACTED_SECRET);
      expect(JSON.stringify(redactSecretsInValue({ type: "image", source: { url } }))).toContain(REDACTED_SECRET);
      expect(JSON.stringify(redactSecretsInValue({ type: "image", source: { type: "base64", data: body(url) } }))).toContain(REDACTED_SECRET);
    }
    expect(JSON.stringify(redactSecretsInValue(imageUrlBlock(notAnImage)))).not.toContain(BASE58_SECRET_KEY);
  });

  test("in a document, under a credential key, and in a block of another type", () => {
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: body(REAL_SCREENSHOT_CROP_JPEG) } };
    expect(JSON.stringify(redactSecretsInValue(pdf))).toContain(REDACTED_SECRET);
    expect(redactSecretsInValue({ token: imageUrlBlock(REAL_SCREENSHOT_CROP_JPEG) }))
      .toEqual({ token: { type: REDACTED_SECRET, image_url: { url: REDACTED_SECRET } } });
    const lookalike = { type: "input_image", image_url: { url: REAL_SCREENSHOT_CROP_JPEG } };
    expect(JSON.stringify(redactSecretsInValue(lookalike))).toContain(REDACTED_SECRET);
  });
});
