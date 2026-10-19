import { afterEach, describe, expect, test } from "vitest";
import stripAnsi from "strip-ansi";
import { applyMarkdown } from "../../src/utils/markdown.js";

// Chat links must never let a lookalike host pass for the real site. With OSC 8
// hyperlinks only the link text is visible, so `[amazon.com](https://аmazon.com)`
// used to render as a bare "amazon.com" that opened `xn--mazon-3ve.com`.

const CYRILLIC_A = "а";
const FAKE_AMAZON = `https://${CYRILLIC_A}mazon.com/login`;
const OSC8 = /\x1b\]8;;([^\x07]*)\x07/g;

const originalForceHyperlink = process.env.FORCE_HYPERLINK;

afterEach(() => {
  if (originalForceHyperlink === undefined) delete process.env.FORCE_HYPERLINK;
  else process.env.FORCE_HYPERLINK = originalForceHyperlink;
});

function render(markdown: string, hyperlinks: boolean): { visible: string; targets: string[] } {
  process.env.FORCE_HYPERLINK = hyperlinks ? "1" : "0";
  const out = applyMarkdown(markdown, "dark");
  const targets = [...out.matchAll(OSC8)].map((match) => match[1]!).filter(Boolean);
  return { visible: stripAnsi(out.replace(OSC8, "")), targets };
}

describe("markdown links show the real site", () => {
  test("a lookalike link names its real host and targets the ASCII form", () => {
    const { visible, targets } = render(`Log in at [amazon.com](${FAKE_AMAZON}).`, true);
    expect(visible).toBe("Log in at amazon.com (xn--mazon-3ve.com).");
    expect(targets).toEqual(["https://xn--mazon-3ve.com/login"]);
  });

  test("a link whose text names another site shows where it really goes", () => {
    const { visible } = render("[amazon.com](https://evil.example/login)", true);
    expect(visible).toBe("amazon.com (evil.example)");
  });

  test("no hint when the text already shows the host", () => {
    const { visible } = render("[see react.dev](https://react.dev/learn)", true);
    expect(visible).toBe("see react.dev");
  });

  test("relative links get no hint", () => {
    const { visible } = render("[index.ts](runtime/src/index.ts)", true);
    expect(visible).toBe("index.ts");
  });

  test("without hyperlink support the revealed URL itself is printed", () => {
    const { visible } = render(`[amazon.com](${FAKE_AMAZON})`, false);
    expect(visible).toBe("https://xn--mazon-3ve.com/login");
  });

  test("plain-text URLs show the real host", () => {
    const { visible } = render(`Go to ${FAKE_AMAZON} now`, true);
    expect(visible).toBe("Go to https://xn--mazon-3ve.com/login now");
  });

  test("plain-text URLs in list items show the real host", () => {
    const { visible } = render(`- ${FAKE_AMAZON}`, true);
    expect(visible).toContain("https://xn--mazon-3ve.com/login");
    expect(visible).not.toContain(`${CYRILLIC_A}mazon`);
  });
});
