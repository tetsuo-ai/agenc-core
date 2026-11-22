import { afterEach, describe, expect, it } from "vitest";

import { browserOpenCommand, safeBrowserUrl } from "../../src/utils/browser.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const SIGN_IN_URL =
  "https://accounts.example.test/o/oauth2/v2/auth?client_id=a&redirect_uri=b&state=c";

function runOn(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platform, value });
}

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

describe("safeBrowserUrl", () => {
  it("returns an http(s) link in its normalized form", () => {
    expect(safeBrowserUrl(SIGN_IN_URL)).toBe(SIGN_IN_URL);
    expect(safeBrowserUrl("HTTP://Example.TEST")).toBe("http://example.test/");
  });

  it.each([
    "file:///tmp/sign-in.html",
    "ftp://example.test/sign-in",
    "mailto:user@example.test",
    "agenc-desktop://sign-in",
  ])("refuses %s", (url) => {
    expect(() => safeBrowserUrl(url)).toThrow(/must use http:\/\/ or https:\/\//);
  });

  it("refuses text that is not a URL", () => {
    expect(() => safeBrowserUrl("example.test/sign-in")).toThrow(/Invalid URL format/);
  });
});

describe("browserOpenCommand", () => {
  it("opens with rundll32 on Windows and passes the whole URL as one argument", () => {
    runOn("win32");
    expect(browserOpenCommand(SIGN_IN_URL)).toEqual({
      command: "rundll32",
      args: ["url,OpenURL", SIGN_IN_URL],
    });
  });

  it("opens with open on macOS and xdg-open on Linux", () => {
    runOn("darwin");
    expect(browserOpenCommand(SIGN_IN_URL)).toEqual({ command: "open", args: [SIGN_IN_URL] });
    runOn("linux");
    expect(browserOpenCommand(SIGN_IN_URL)).toEqual({ command: "xdg-open", args: [SIGN_IN_URL] });
  });
});
