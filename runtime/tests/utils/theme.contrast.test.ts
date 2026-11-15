import { describe, expect, test } from "vitest";
import { getTheme, type Theme } from "../../src/utils/theme.js";

// WCAG 2.x relative luminance and contrast ratio.
function luminance(color: string): number {
  const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color);
  if (!match) throw new Error(`not an rgb color: ${color}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const TEXT_TOKENS: readonly (keyof Theme)[] = [
  "text", "text2", "text3", "codeText", "inactive", "subtle",
  "accent", "accentSoft", "stepOk", "stepFail", "success", "error",
];
// The surface each theme is drawn for, and the terminal backgrounds it meets.
const SURFACES = {
  dark: ["rgb(0,0,0)"],
  olive: ["rgb(25,27,17)", "rgb(30,30,30)"],
  light: ["rgb(255,255,255)"],
} as const;
const ANY_TERMINAL = ["rgb(0,0,0)", "rgb(30,30,30)", "rgb(255,255,255)"];

describe("theme contrast", () => {
  for (const [name, surfaces] of Object.entries(SURFACES)) {
    const theme = getTheme(name as keyof typeof SURFACES);
    test(`${name}: every text color reaches 4.5:1 on its backgrounds`, () => {
      for (const surface of surfaces) {
        for (const token of TEXT_TOKENS) {
          expect({ token, surface, ratio: contrast(theme[token] as string, surface) >= 4.5 })
            .toEqual({ token, surface, ratio: true });
        }
      }
    });

    test(`${name}: the mouse selection stands out from any terminal and keeps its text readable`, () => {
      for (const terminal of [...surfaces, ...ANY_TERMINAL]) {
        expect({ terminal, ratio: contrast(theme.selectionBg, terminal) >= 3 })
          .toEqual({ terminal, ratio: true });
      }
      expect(contrast(theme.selectionFg, theme.selectionBg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("light: the placeholder gray stays readable on the prompt band", () => {
    const light = getTheme("light");
    expect(contrast(light.text3, light.promptBackground)).toBeGreaterThanOrEqual(4.5);
  });
});
