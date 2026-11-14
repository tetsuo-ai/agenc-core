import { describe, expect, test } from "vitest";

import { getTheme, THEME_NAMES } from "../../src/utils/theme.js";

describe("sent-message band", () => {
  // Owner request (2026-11-14): a sent message sits on the same band as the
  // input box it came from, same height and same color.
  test("uses the input box color in every theme", () => {
    for (const name of THEME_NAMES) {
      const theme = getTheme(name);
      expect(theme.userBand, name).toBe(theme.promptBackground);
    }
  });
});
