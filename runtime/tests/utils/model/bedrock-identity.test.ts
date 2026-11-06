import { describe, expect, test } from "vitest";

import {
  isOpaqueBedrockModelArn,
  resolveBedrockModelIdentity,
} from "../../../src/utils/model/claudeModelId.js";

const APPLICATION_PROFILE =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/prod-opus";
const SYSTEM_PROFILE =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5";
const FOUNDATION_MODEL =
  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5";

describe("isOpaqueBedrockModelArn", () => {
  test("treats application, provisioned, custom, and router ARNs as unnamed", () => {
    for (const model of [
      APPLICATION_PROFILE,
      "arn:aws:bedrock:us-east-1:123456789012:provisioned-model/custom-opus",
      "arn:aws:bedrock:us-east-1:123456789012:custom-model/fine-tuned-opus",
      "arn:aws:bedrock:us-east-1:123456789012:prompt-router/default",
      "arn:aws-cn:bedrock:cn-north-1:123456789012:application-inference-profile/cn-opus",
      "  ARN:AWS:BEDROCK:us-east-1:1:APPLICATION-INFERENCE-PROFILE/PROD  ",
    ]) {
      expect(isOpaqueBedrockModelArn(model), model).toBe(true);
    }
  });

  test("reads foundation-model and system inference-profile ARNs as named", () => {
    for (const model of [
      SYSTEM_PROFILE,
      FOUNDATION_MODEL,
      "anthropic.claude-opus-5-5",
      "us.anthropic.claude-opus-5-5-v1:0",
      "claude-opus-5-5",
    ]) {
      expect(isOpaqueBedrockModelArn(model), model).toBe(false);
    }
  });
});

describe("resolveBedrockModelIdentity", () => {
  test("returns a named Claude id unchanged, including when overrides exist", () => {
    const overrides = {
      "claude-sonnet-4-5": APPLICATION_PROFILE,
      "claude-opus-5-5": APPLICATION_PROFILE,
    };
    for (const model of [
      "claude-opus-5-5",
      "anthropic.claude-opus-5-5",
      "us.anthropic.claude-opus-5-5-v1:0",
      SYSTEM_PROFILE,
    ]) {
      expect(resolveBedrockModelIdentity(model, overrides), model).toBe(model);
    }
    expect(resolveBedrockModelIdentity(APPLICATION_PROFILE, undefined)).toBe(
      APPLICATION_PROFILE,
    );
  });

  test("maps an unnamed override back to the Claude foundation-model spelling", () => {
    expect(
      resolveBedrockModelIdentity(APPLICATION_PROFILE, {
        "claude-opus-5-5-20260922": ` ${APPLICATION_PROFILE} `,
        "not-a-claude-model": APPLICATION_PROFILE,
      }),
    ).toBe("anthropic.claude-opus-5-5");
    expect(
      resolveBedrockModelIdentity(` ${APPLICATION_PROFILE} `, {
        "claude-sonnet-4-5": APPLICATION_PROFILE,
      }),
    ).toBe("anthropic.claude-sonnet-4-5");
  });

  test("keeps the requested id when no Claude override matches", () => {
    expect(
      resolveBedrockModelIdentity(APPLICATION_PROFILE, {
        "gpt-5": APPLICATION_PROFILE,
        "claude-opus-5-5": "arn:aws:bedrock:us-east-1:1:application-inference-profile/other",
      }),
    ).toBe(APPLICATION_PROFILE);
  });
});
