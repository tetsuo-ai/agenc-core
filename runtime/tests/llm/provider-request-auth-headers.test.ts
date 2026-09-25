import { describe, expect, it } from "vitest";

import { stripForwardedProviderAuthHeaders } from "../../src/llm/provider-request.js";

describe("stripForwardedProviderAuthHeaders", () => {
  it("drops forwarded auth headers regardless of spelling and keeps the rest", () => {
    expect(
      stripForwardedProviderAuthHeaders({
        Authorization: "Bearer leaked",
        "X-API-Key": "stale-key",
        "api-key": "also-stale",
        "X-Goog-Api-Key": "google-key",
        "X-Goog-User-Project": "proj",
        "X-Prepared": "keep",
        "Content-Type": "application/json",
      }),
    ).toEqual({
      "X-Prepared": "keep",
      "Content-Type": "application/json",
    });
  });

  it("returns an empty object when every header is auth or the input is empty", () => {
    expect(
      stripForwardedProviderAuthHeaders({
        authorization: "Bearer x",
        "x-api-key": "y",
      }),
    ).toEqual({});
    expect(stripForwardedProviderAuthHeaders({})).toEqual({});
  });
});
