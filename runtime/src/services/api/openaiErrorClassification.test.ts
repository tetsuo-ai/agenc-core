import { describe, expect, test } from "vitest";

import { classifyOpenAIHttpFailure } from "./openaiErrorClassification.js";

describe("classifyOpenAIHttpFailure", () => {
  test("distinguishes invalid credentials from forbidden org/project access", () => {
    const unauthorized = classifyOpenAIHttpFailure({
      status: 401,
      body: '{"error":{"message":"invalid api key"}}',
    });
    const forbidden = classifyOpenAIHttpFailure({
      status: 403,
      body: '{"error":{"message":"project does not exist"}}',
    });

    expect(unauthorized.category).toBe("auth_invalid");
    expect(unauthorized.code).toBe("auth_invalid_api_key");
    expect(unauthorized.hint).toContain("API key");

    expect(forbidden.category).toBe("auth_invalid");
    expect(forbidden.code).toBe("auth_forbidden_org_project");
    expect(forbidden.hint).toContain("organization/project");
  });
});
