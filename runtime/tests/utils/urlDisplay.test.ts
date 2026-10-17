import { describe, expect, test } from "vitest";
import {
  isInternationalizedHost,
  revealUrlHosts,
  textShowsHost,
  webUrlHost,
} from "../../src/utils/urlDisplay.js";

// Cyrillic `а` (U+0430) looks exactly like Latin `a` but makes a different
// domain: `аmazon.com` is really `xn--mazon-3ve.com`.
const CYRILLIC_A = "а";
const FAKE_AMAZON = `https://${CYRILLIC_A}mazon.com/login`;

describe("revealUrlHosts", () => {
  test("rewrites a lookalike host to the ASCII form the network uses", () => {
    expect(revealUrlHosts(FAKE_AMAZON)).toBe("https://xn--mazon-3ve.com/login");
  });

  test("leaves ASCII URLs and plain text untouched", () => {
    const text = "See https://amazon.com/login and docs.";
    expect(revealUrlHosts(text)).toBe(text);
  });

  test("rewrites only the host, keeping path, query, port and prose", () => {
    expect(
      revealUrlHosts(`Log in (${FAKE_AMAZON}?next=/cart) or http://${CYRILLIC_A}mazon.com:8080/x.`),
    ).toBe(
      "Log in (https://xn--mazon-3ve.com/login?next=/cart) or http://xn--mazon-3ve.com:8080/x.",
    );
  });

  test("reveals the host behind userinfo that imitates a site", () => {
    expect(revealUrlHosts(`https://amazon.com@${CYRILLIC_A}vil.com/`)).toBe(
      "https://amazon.com@xn--vil-5cd.com/",
    );
  });

  test("reveals every URL in the text", () => {
    expect(
      revealUrlHosts(`${FAKE_AMAZON} and https://p${CYRILLIC_A}yp${CYRILLIC_A}l.com`),
    ).toBe("https://xn--mazon-3ve.com/login and https://xn--pypl-53dc.com");
  });

  test("leaves non-ASCII text outside URLs alone", () => {
    expect(revealUrlHosts("Привет, see https://example.com")).toBe(
      "Привет, see https://example.com",
    );
  });
});

describe("webUrlHost", () => {
  test("returns the ASCII host of http(s) URLs", () => {
    expect(webUrlHost(FAKE_AMAZON)).toBe("xn--mazon-3ve.com");
    expect(webUrlHost("https://Docs.Example.com/a")).toBe("docs.example.com");
  });

  test("ignores relative paths and non-web schemes", () => {
    expect(webUrlHost("runtime/src/index.ts")).toBeUndefined();
    expect(webUrlHost("mailto:a@example.com")).toBeUndefined();
    expect(webUrlHost("file:///etc/hosts")).toBeUndefined();
  });
});

describe("isInternationalizedHost", () => {
  test("flags any xn-- label", () => {
    expect(isInternationalizedHost("xn--mazon-3ve.com")).toBe(true);
    expect(isInternationalizedHost("shop.xn--80ak6aa92e.com")).toBe(true);
    expect(isInternationalizedHost("amazon.com")).toBe(false);
  });
});

describe("textShowsHost", () => {
  test("matches the host case-insensitively, ignoring a leading www.", () => {
    expect(textShowsHost("Open Amazon.com", "www.amazon.com")).toBe(true);
    expect(textShowsHost("amazon.com", "xn--mazon-3ve.com")).toBe(false);
    expect(textShowsHost("docs", "react.dev")).toBe(false);
  });
});
