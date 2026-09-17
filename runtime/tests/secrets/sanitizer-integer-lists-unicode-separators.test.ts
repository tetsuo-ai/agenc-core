import { describe, expect, test } from "vitest";
import { redactSecrets, REDACTED_SECRET } from "../../src/secrets/sanitizer.js";
import { llmMessageToDurableResponseItem } from "../../src/session/message-history-conversion.js";
import { createToolResultIntegrity, verifyToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

const bytes = (count: number) => Array.from({ length: count }, (_, index) => (index * 37 + 11) % 256);
const spaces = [
  { name: "NBSP", value: "\u00a0" },
  { name: "EM SPACE", value: "\u2003" },
  { name: "LINE SEPARATOR", value: "\u2028" },
  { name: "NARROW NBSP", value: "\u202f" },
];

describe("integer-list redaction compatibility", () => {
  for (const count of [32, 64]) {
    test.each(spaces)("protects " + count + " unsigned bytes separated with $name", ({ value }) => {
      const list = "[" + value + bytes(count).join("," + value) + value + "]";
      expect(redactSecrets("dump: " + list)).toBe("dump: " + REDACTED_SECRET);
    });
  }

  test("keeps Unicode-formatted key material out of durable tool history", () => {
    const list = "[" + bytes(64).join(",\u00a0") + "]";
    const content = "synthetic key-shaped dump: " + list;
    const item = llmMessageToDurableResponseItem({
      role: "tool", toolCallId: "synthetic-list-call", toolName: "exec_command", content,
      runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
        runId: "synthetic-list-review", toolCallId: "synthetic-list-call", content,
      }) },
    });
    expect(String(item.content).includes(list)).toBe(false);
    expect(item.toolResultIntegrity?.persisted.representation).toBe("redacted");
    expect(verifyToolResultIntegrity({
      integrity: item.toolResultIntegrity, toolCallId: "synthetic-list-call", content: item.content,
    })).toMatchObject({ status: "valid" });
  });
});

describe("integer-list intended-policy controls", () => {
  test.each([32, 64])("still protects %i ASCII-separated bytes", count => {
    expect(redactSecrets(JSON.stringify(bytes(count)))).toBe(REDACTED_SECRET);
  });

  test("preserves the intended benign 80-index list", () => {
    const data = JSON.stringify(Array.from({ length: 80 }, (_, index) => index));
    expect(redactSecrets(data)).toBe(data);
  });
});

