import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_SERVER_IDENTIFIER_LENGTH,
  boundScopedServerIdentifier,
} from "../../src/identifiers/server-name.js";

describe("boundScopedServerIdentifier", () => {
  it("keeps short identifiers verbatim, including the 256-character boundary", () => {
    expect(boundScopedServerIdentifier("slack")).toBe("slack");
    const exact = "s".repeat(MAX_SERVER_IDENTIFIER_LENGTH);
    expect(boundScopedServerIdentifier(exact)).toBe(exact);
  });

  it("compacts a longer identifier with a deterministic SHA-256 suffix", () => {
    const value = "plugin." + "n".repeat(300);
    const digest = createHash("sha256").update(value, "utf8").digest("hex");
    const suffix = `:${digest}`;
    const bounded = boundScopedServerIdentifier(value);

    expect(bounded).toHaveLength(MAX_SERVER_IDENTIFIER_LENGTH);
    expect(bounded.endsWith(suffix)).toBe(true);
    expect(bounded.startsWith(value.slice(0, MAX_SERVER_IDENTIFIER_LENGTH - suffix.length))).toBe(
      true,
    );
    expect(boundScopedServerIdentifier(value)).toBe(bounded);
  });

  it("gives different long names different suffixes", () => {
    const left = boundScopedServerIdentifier("a".repeat(300));
    const right = boundScopedServerIdentifier("b".repeat(300));
    expect(left).not.toBe(right);
    expect(left.slice(-64)).not.toBe(right.slice(-64));
  });
});
