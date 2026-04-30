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
    expect(isPreapprovedHost("github.com", "/anthropics")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics/foo")).toBe(true);
    expect(isPreapprovedHost("github.com", "/anthropics-evil")).toBe(false);
    expect(isPreapprovedHost("github.com", "/other-org")).toBe(false);
  });

  it("rejects unknown hosts", () => {
    expect(isPreapprovedHost("malicious.example.com", "/")).toBe(false);
    expect(isPreapprovedHost("nodejs.org.attacker.example", "/")).toBe(false);
  });

  it("isPreapprovedUrl parses and accepts valid HTTPS URLs", () => {
    expect(isPreapprovedUrl("https://react.dev/learn")).toBe(true);
    expect(
      isPreapprovedUrl("https://github.com/anthropics/anthropic-sdk-typescript"),
    ).toBe(true);
    expect(isPreapprovedUrl("https://github.com/random-org/repo")).toBe(false);
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
