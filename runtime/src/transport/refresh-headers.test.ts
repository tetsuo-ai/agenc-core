import { describe, expect, it } from "vitest";
import {
  applyRefreshedHeaders,
  refreshAuthHeaders,
} from "./refresh-headers.js";

describe("applyRefreshedHeaders", () => {
  it("normalizes stale bearer headers away when cookie auth is already present", () => {
    expect(
      applyRefreshedHeaders({
        Authorization: "Bearer stale",
        Cookie: "sessionKey=sk-ant-sid-123",
        "X-Organization-Uuid": "org-1",
      }),
    ).toEqual({
      Cookie: "sessionKey=sk-ant-sid-123",
      "X-Organization-Uuid": "org-1",
    });
  });

  it("merges refreshed bearer headers", () => {
    expect(
      applyRefreshedHeaders(
        { Authorization: "Bearer old", Accept: "text/event-stream" },
        () => ({ Authorization: "Bearer new" }),
      ),
    ).toEqual({
      Authorization: "Bearer new",
      Accept: "text/event-stream",
    });
  });

  it("drops stale Authorization when refresh switches to Cookie auth", () => {
    expect(
      applyRefreshedHeaders(
        { Authorization: "Bearer old" },
        () => ({
          Cookie: "sessionKey=sk-ant-sid-123",
          "X-Organization-Uuid": "org-1",
        }),
      ),
    ).toEqual({
      Cookie: "sessionKey=sk-ant-sid-123",
      "X-Organization-Uuid": "org-1",
    });
  });
});

describe("refreshAuthHeaders", () => {
  it("detects auth changes across bearer and cookie variants", () => {
    const refreshed = refreshAuthHeaders(
      { Authorization: "Bearer old" },
      () => ({
        Cookie: "sessionKey=sk-ant-sid-123",
        "X-Organization-Uuid": "org-1",
      }),
    );

    expect(refreshed.changed).toBe(true);
    expect(refreshed.headers).toEqual({
      Cookie: "sessionKey=sk-ant-sid-123",
      "X-Organization-Uuid": "org-1",
    });
  });

  it("ignores non-auth header churn when computing auth change", () => {
    const refreshed = refreshAuthHeaders(
      { Authorization: "Bearer stable", Accept: "text/event-stream" },
      () => ({
        Authorization: "Bearer stable",
        Accept: "application/json",
      }),
    );

    expect(refreshed.changed).toBe(false);
    expect(refreshed.headers).toEqual({
      Authorization: "Bearer stable",
      Accept: "application/json",
    });
  });
});
