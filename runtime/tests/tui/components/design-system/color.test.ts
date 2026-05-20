import { beforeEach, describe, expect, test, vi } from "vitest";

import { color } from "./color.js";

const mocks = vi.hoisted(() => ({
  colorizeCalls: [] as Array<{
    text: string;
    color: string | undefined;
    type: string;
  }>,
  themeCalls: [] as string[],
}));

vi.mock("../../ink/colorize.js", () => ({
  colorize: (text: string, colorValue: string | undefined, type: string) => {
    mocks.colorizeCalls.push({ text, color: colorValue, type });
    return `${type}:${colorValue}:${text}`;
  },
}));

vi.mock("../../../utils/theme.js", () => ({
  getTheme: (themeName: string) => {
    mocks.themeCalls.push(themeName);
    return { agenc: "#ff6600", text: "ansi:white" };
  },
}));

describe("design-system color", () => {
  beforeEach(() => {
    mocks.colorizeCalls = [];
    mocks.themeCalls = [];
  });

  test("returns text unchanged when no color is configured", () => {
    expect(color(undefined, "dark")("plain")).toBe("plain");
    expect(mocks.colorizeCalls).toEqual([]);
    expect(mocks.themeCalls).toEqual([]);
  });

  test.each(["rgb(1,2,3)", "#123456", "ansi256(42)", "ansi:red"])(
    "passes raw color value %s directly to colorize",
    rawColor => {
      expect(color(rawColor, "dark")("raw")).toBe(`foreground:${rawColor}:raw`);
    },
  );

  test("resolves theme color keys before colorizing", () => {
    expect(color("agenc", "dark")("branded")).toBe(
      "foreground:#ff6600:branded",
    );
    expect(mocks.themeCalls).toEqual(["dark"]);
  });

  test("passes the requested color type through to colorize", () => {
    expect(color("text", "dark", "background")("label")).toBe(
      "background:ansi:white:label",
    );
  });
});
