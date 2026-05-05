import { describe, expect, it } from "vitest";
import {
  isPreapprovedHost,
  isPreapprovedUrl,
  PREAPPROVED_HOSTS,
} from "./web-fetch-preapproved.js";

describe("web-fetch-preapproved", () => {
  it("hostname-only entries match exact hosts", () => {
    expect(isPreapprovedHost("react.dev", "/")).toBe(true);
    expect(isPreapprovedHost("docs.python.org", "/3/library/asyncio.html")).toBe(
      true,
    );
  });

  it("path-prefix entries enforce segment boundaries", () => {
    expect(isPreapprovedHost("github.com", "/modelcontextprotocol")).toBe(true);
    expect(isPreapprovedHost("github.com", "/modelcontextprotocol/foo")).toBe(true);
    expect(isPreapprovedHost("github.com", "/modelcontextprotocol-evil")).toBe(false);
    expect(isPreapprovedHost("github.com", "/other-org")).toBe(false);
  });

  it("rejects unknown hosts", () => {
    expect(isPreapprovedHost("localhost", "/")).toBe(false);
    expect(isPreapprovedHost("127.0.0.1", "/")).toBe(false);
  });

  it("isPreapprovedUrl parses and accepts valid HTTPS URLs", () => {
    expect(isPreapprovedUrl("https://react.dev/learn")).toBe(true);
    expect(
      isPreapprovedUrl("https://github.com/modelcontextprotocol/typescript-sdk"),
    ).toBe(true);
    expect(isPreapprovedUrl("https://github.com/random-org/repo")).toBe(false);
  });

  it("isPreapprovedUrl rejects non-HTTPS URLs on preapproved hosts", () => {
    expect(isPreapprovedUrl("http://react.dev/learn")).toBe(false);
    expect(isPreapprovedUrl("ftp://react.dev/learn")).toBe(false);
  });

  it("isPreapprovedUrl rejects malformed URLs", () => {
    expect(isPreapprovedUrl("not-a-url")).toBe(false);
    expect(isPreapprovedUrl("")).toBe(false);
  });

  it("preapproved set covers the agenc baseline domain count", () => {
    // Sanity: catch accidental deletions during merges. The agenc
    // baseline at port time was ~85 entries; allow some flex.
    expect(PREAPPROVED_HOSTS.size).toBeGreaterThanOrEqual(70);
  });
});
