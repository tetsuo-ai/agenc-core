import { describe, expect, test } from "vitest";

import { applySGR } from "./sgr.js";
import { defaultStyle } from "./types.js";

describe("applySGR", () => {
  test("applies and clears basic text attributes", () => {
    const style = applySGR(
      "1;2;3;4;5;7;8;9;53;22;23;24;25;27;28;29;55",
      defaultStyle(),
    );

    expect(style).toEqual(defaultStyle());
  });

  test("supports underline style variants and double underline alias", () => {
    expect(applySGR("4", defaultStyle()).underline).toBe("single");
    expect(applySGR("21", defaultStyle()).underline).toBe("double");
    expect(applySGR("4:2", defaultStyle()).underline).toBe("double");
    expect(applySGR("4:3", defaultStyle()).underline).toBe("curly");
    expect(applySGR("4:4", defaultStyle()).underline).toBe("dotted");
    expect(applySGR("4:5", defaultStyle()).underline).toBe("dashed");
    expect(applySGR("4:99", defaultStyle()).underline).toBe("single");
  });

  test("applies standard and bright foreground/background colors", () => {
    expect(applySGR("30;47", defaultStyle())).toEqual(
      expect.objectContaining({
        bg: { name: "white", type: "named" },
        fg: { name: "black", type: "named" },
      }),
    );
    expect(applySGR("91;104", defaultStyle())).toEqual(
      expect.objectContaining({
        bg: { name: "brightBlue", type: "named" },
        fg: { name: "brightRed", type: "named" },
      }),
    );
  });

  test("resets foreground, background, and underline colors independently", () => {
    const colored = applySGR("31;42;58;5;123", defaultStyle());
    expect(colored).toEqual(
      expect.objectContaining({
        bg: { name: "green", type: "named" },
        fg: { name: "red", type: "named" },
        underlineColor: { index: 123, type: "indexed" },
      }),
    );

    expect(applySGR("39;49;59", colored)).toEqual(defaultStyle());
  });

  test("applies semicolon extended indexed and RGB colors", () => {
    const style = applySGR(
      "38;5;202;48;2;10;20;30;58;2;1;2;3",
      defaultStyle(),
    );

    expect(style).toEqual(
      expect.objectContaining({
        bg: { b: 30, g: 20, r: 10, type: "rgb" },
        fg: { index: 202, type: "indexed" },
        underlineColor: { b: 3, g: 2, r: 1, type: "rgb" },
      }),
    );
  });

  test("applies colon extended indexed and RGB colors", () => {
    const style = applySGR(
      "38:5:12;48:2:10:20:30;58:2:0:1:2:3",
      defaultStyle(),
    );

    expect(style).toEqual(
      expect.objectContaining({
        bg: { b: 30, g: 20, r: 10, type: "rgb" },
        fg: { index: 12, type: "indexed" },
        underlineColor: { b: 3, g: 2, r: 1, type: "rgb" },
      }),
    );
  });

  test("ignores unknown parameters without discarding existing style", () => {
    const base = applySGR("1;31", defaultStyle());
    const updated = applySGR("999", base);

    expect(updated).toEqual(base);
  });

  test("empty or missing parameters reset the style", () => {
    expect(applySGR("", applySGR("1;31", defaultStyle()))).toEqual(defaultStyle());
    expect(applySGR(";", applySGR("1;31", defaultStyle()))).toEqual(defaultStyle());
  });
});
