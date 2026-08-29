import { describe, expect, it } from "vitest";

import {
  MACOS_OPTION_SPECIAL_CHARS,
  isMacosOptionChar,
} from "../../src/utils/keyboardShortcuts.js";

describe("macOS Option shortcut translation", () => {
  it("contains only active Option shortcuts", () => {
    expect(MACOS_OPTION_SPECIAL_CHARS).toEqual({
      "†": "alt+t",
      π: "alt+p",
    });
    expect(isMacosOptionChar("ø")).toBe(false);
  });
});
