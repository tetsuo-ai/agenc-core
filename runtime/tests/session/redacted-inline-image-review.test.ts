import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { redactSecrets, REDACTED_SECRET } from "../../src/secrets/sanitizer.js";
import {
  assertNoBrokenInlineImages,
  isCanonicalBase64Image,
  projections,
  roundTrip,
  syntheticPng,
} from "../helpers/redacted-inline-image-fixture.js";

describe("independent durable image projection", () => {
  test("the synthetic PNG is valid base64 and triggers the existing heuristic", () => {
    const url = syntheticPng(true);
    expect(isCanonicalBase64Image(url)).toBe(true);
    expect(redactSecrets(url)).toContain(REDACTED_SECRET);
    expect(isCanonicalBase64Image(redactSecrets(url))).toBe(false);
  });

  test.each(projections)("%s never replays partially redacted image bytes", (_name, project) => {
    const message = roundTrip({
      role: "user",
      content: [
        { type: "text", text: "synthetic thumbnail" },
        { type: "image_url", image_url: { url: syntheticPng(true) } },
      ],
    }, project);
    // A safe implementation may preserve validated binary or replace the
    // altered carrier with an omission. It must never transmit damaged base64.
    assertNoBrokenInlineImages(message);
  });

  test.each(projections)("%s keeps an ordinary unchanged PNG", (_name, project) => {
    const url = syntheticPng(false);
    expect(redactSecrets(url)).toBe(url);
    const message = roundTrip({
      role: "user",
      content: [
        { type: "text", text: "synthetic thumbnail" },
        { type: "image_url", image_url: { url } },
      ],
    }, project);
    assertNoBrokenInlineImages(message);
    expect(JSON.stringify(message.content)).toContain(url);
  });

  test.each(projections)("%s still redacts a fake credential outside binary data", (_name, project) => {
    const fakeCredential = `sk-${"x".repeat(36)}`;
    const message = roundTrip({
      role: "user", content: `synthetic thumbnail credential ${fakeCredential}`,
    }, project);
    expect(message.content).toContain(REDACTED_SECRET);
    expect(message.content).not.toContain(fakeCredential);
  });

  test.each(projections)("%s does not trust a binary label around fake plaintext credentials", (_name, project) => {
    const fakeCredential = `sk-${"x".repeat(36)}`;
    const source: LLMMessage = {
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: `data:image/png;base64,${fakeCredential}` },
      }],
    };
    expect(JSON.stringify(project(source))).not.toContain(fakeCredential);
    expect(JSON.stringify(roundTrip(source, project))).not.toContain(fakeCredential);
  });
});
