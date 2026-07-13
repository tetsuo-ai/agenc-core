import { describe, expect, it } from "vitest";

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
} from "../../../src/tui/ink/parse-keypress.js";

// parse-keypress.ts:199 minor (core-todo.md): inputToString mutated the caller-owned
// Buffer in place (`input[0] -= 128`) for the single-byte >127 case, corrupting it for
// any downstream reader. Fixed by building the escaped char without mutation.

describe("parseMultipleKeypresses — does not mutate the input Buffer", () => {
  it("leaves a single-byte >127 Buffer unchanged", () => {
    const buf = Buffer.from([200]); // >127, single byte -> the meta-escape branch
    const before = buf[0];
    const [parsed] = parseMultipleKeypresses(INITIAL_STATE, buf);

    // The caller's buffer is untouched (pre-fix it was mutated to 200-128=72).
    expect(buf[0]).toBe(before);
    expect(buf[0]).toBe(200);
    // Parsing still produced a result (the escaped char), not a crash.
    expect(Array.isArray(parsed)).toBe(true);
  });
});
