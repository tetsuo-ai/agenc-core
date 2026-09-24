import { describe, expect, test } from "vitest";

import { fitOutputReservationToContext } from "../../src/budget/admitted-model-call.js";

const windowTokens = 950_000;
const requested = 131_072;
const inputTokens = 948_879;
const accounting = {
  admissible: true,
  inputTokens,
  totalTokens: inputTokens + requested,
};

describe("fitOutputReservationToContext buffer sanitization", () => {
  test("a missing declaration keeps the previous no-buffer arithmetic", () => {
    expect(fitOutputReservationToContext(accounting, windowTokens, requested)).toBe(1_121);
    expect(fitOutputReservationToContext(accounting, windowTokens, requested, 0)).toBe(1_121);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -1024])(
    "a non-finite or negative declaration %s does not tighten the fit",
    (buffer) => {
      expect(fitOutputReservationToContext(accounting, windowTokens, requested, buffer)).toBe(1_121);
    },
  );

  test("a fractional declaration floors before measuring room", () => {
    expect(fitOutputReservationToContext(accounting, windowTokens, requested, 1024.9)).toBeUndefined();
    expect(fitOutputReservationToContext(accounting, windowTokens, requested, 1024)).toBeUndefined();
    expect(
      fitOutputReservationToContext(
        { admissible: true, inputTokens: 947_952, totalTokens: 947_952 + requested },
        windowTokens,
        requested,
        1024.9,
      ),
    ).toBe(1_024);
  });
});
