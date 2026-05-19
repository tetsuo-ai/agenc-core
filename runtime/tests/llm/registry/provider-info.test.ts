import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROVIDER_SCOPE_OMISSIONS,
  resolveBuiltInProviderInfo,
} from "./provider-info.js";

describe("built-in provider info", () => {
  it("registers Amazon Bedrock as a SigV4-backed runtime provider", () => {
    expect(resolveBuiltInProviderInfo("amazon-bedrock")).toMatchObject({
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      defaultModel: "amazon.nova-pro-v1:0",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKeyEnvVar: "AWS_ACCESS_KEY_ID",
    });
    expect(BUILT_IN_PROVIDER_SCOPE_OMISSIONS).not.toHaveProperty(
      "amazon-bedrock",
    );
  });
});
