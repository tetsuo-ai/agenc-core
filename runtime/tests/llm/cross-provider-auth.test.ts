import { describe, expect, it } from "vitest";

import {
  assertSupportedCrossProviderAuth,
  type ChildAuthProfile,
} from "../../src/llm/cross-provider-auth.js";

const SUPPORTED: ReadonlyArray<readonly [string, ChildAuthProfile]> = [
  ["openai", "sign_in"],
  ["grok", "sign_in"],
  ["anthropic", "api_key"],
  ["deepseek", "managed"],
  ["ollama", "local"],
  ["lmstudio", "local"],
  ["openai-compatible", "local"],
  ["amazon-bedrock", "aws_sigv4"],
];

const REJECTED: ReadonlyArray<readonly [string, ChildAuthProfile]> = [
  ["anthropic", "sign_in"],
  ["ollama", "sign_in"],
  ["openai", "local"],
  ["grok", "aws_sigv4"],
  ["amazon-bedrock", "sign_in"],
  ["openai", "aws_sigv4"],
];

describe("assertSupportedCrossProviderAuth", () => {
  it.each(SUPPORTED)("accepts %s with %s at its canonical endpoint", (provider, profile) => {
    expect(() => assertSupportedCrossProviderAuth(provider, profile)).not.toThrow();
  });

  it.each(REJECTED)("rejects %s with %s", (provider, profile) => {
    expect(() => assertSupportedCrossProviderAuth(provider, profile)).toThrow(
      `Cross-provider ${provider} cannot use ${profile} at its canonical endpoint.`,
    );
  });
});
