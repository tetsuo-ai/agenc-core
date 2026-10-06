import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { redactSecrets } from "../../src/secrets/sanitizer.js";
import { projections, roundTrip } from "../helpers/redacted-inline-image-fixture.js";
import { isCanonicalBase64Body } from "../../src/llm/content-conversion.js";

// A base64 PDF body carries the same exposure as an inline image: base58 is a
// subset of the base64 alphabet, so a long enough payload can contain an
// unbroken 80-90 character base58 run that the wallet-key heuristic marks,
// which rewrites bytes inside the document. No real credential is used here.
function syntheticPdf(withCollision: boolean): string {
  const head = Buffer.concat([
    Buffer.from("%PDF-1.4\n", "ascii"),
    deflateSync(Buffer.from("synthetic pdf body")),
  ]);
  const tail = Buffer.from("\n%%EOF\n", "ascii");
  if (!withCollision) return Buffer.concat([head, tail]).toString("base64");
  // Pad to a 3-byte boundary so the collision starts on a base64 quantum and
  // its encoding survives verbatim. Without this the run is split across
  // quanta, no unbroken base58 run appears, and the test proves nothing.
  const pad = Buffer.alloc((3 - (head.length % 3)) % 3);
  const collision = Buffer.from(`00${"A".repeat(80)}00`, "base64");
  return Buffer.concat([head, pad, collision, tail]).toString("base64");
}

function documentOf(message: LLMMessage): Record<string, unknown> | null {
  if (!Array.isArray(message.content)) return null;
  for (const part of message.content) {
    const record = part as unknown as Record<string, unknown>;
    if (record.type === "document") return record;
  }
  return null;
}

function messageWith(data: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "synthetic attachment" },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      },
    ] as unknown as LLMMessage["content"],
  };
}

describe("durable pdf projection", () => {
  test("the synthetic PDF is canonical base64 and trips the heuristic", () => {
    const data = syntheticPdf(true);
    expect(isCanonicalBase64Body(data)).toBe(true);
    expect(redactSecrets(data)).not.toBe(data);
    expect(isCanonicalBase64Body(redactSecrets(data))).toBe(false);
  });

  test.each(projections)("%s never replays partially redacted pdf bytes", (_name, project) => {
    const message = roundTrip(messageWith(syntheticPdf(true)), project);
    const document = documentOf(message);
    if (document !== null) {
      const source = document.source as Record<string, unknown>;
      expect(isCanonicalBase64Body(String(source.data))).toBe(true);
    }
    expect(JSON.stringify(message.content)).toContain("synthetic attachment");
  });

  test.each(projections)("%s keeps an ordinary unchanged pdf", (_name, project) => {
    const data = syntheticPdf(false);
    expect(redactSecrets(data)).toBe(data);
    const message = roundTrip(messageWith(data), project);
    expect(JSON.stringify(message.content)).toContain(data);
  });
});
