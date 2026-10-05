import { resolveProviderCredentialAuthority, requireProviderRuntimeCredential } from "../../src/llm/provider-options.js";
import { expect, it } from "vitest";
import { telegramSessionFailure } from "../../src/gateway/telegram-session-failure.js";
import { LLMMissingCredentialsError } from "../../src/llm/errors.js";

it("reports a missing provider credential from an exception and its RPC projection", () => {
  const error = new LLMMissingCredentialsError("deepseek", "deepseek provider requires credentials. Set DEEPSEEK_API_KEY.");
  for (const value of [error, { code: -32603, message: error.message }]) {
    expect(telegramSessionFailure(value)).toMatchObject({ code: "TELEGRAM_PROVIDER_CREDENTIAL_MISSING", diagnostic: error.message });
    expect(telegramSessionFailure(value).reply).toContain("deepseek");
    expect(telegramSessionFailure(value).reply).toContain("stop and start");
  }
});
it.each([
  [{ data: { code: "REMOTE_WORKSPACE_INVALID" } }, "TELEGRAM_WORKSPACE_INVALID"],
  [{ message: "ENOENT: fixture private folder" }, "TELEGRAM_WORKSPACE_INVALID"],
  [{ code: -32602, message: "private invalid params" }, "TELEGRAM_SESSION_CONFIG_INVALID"],
  [{ message: "unsupported model secret-value" }, "TELEGRAM_SESSION_CONFIG_INVALID"],
])("classifies workspace and settings failures without copying private details", (error, code) => {
  expect(telegramSessionFailure(error).code).toBe(code);
  expect(JSON.stringify(telegramSessionFailure(error))).not.toMatch(/private|secret-value/);
});
it.each([
  new Error("Bearer private-secret credential fixture"),
  { code: -32603, message: "deepseek provider requires credentials. Set PRIVATE_SECRET." },
  { message: "deepseek authentication failed (HTTP 401): deepseek provider requires credentials. Set DEEPSEEK_API_KEY.\nprivate-secret" },
  { message: "https://api.example/?key=private-secret", data: { secret: "private-secret" } },
])("withholds arbitrary exception text and secret-bearing payloads", error => {
  const result = telegramSessionFailure(error);
  expect(result.code).toBe("TELEGRAM_SESSION_CREATE_FAILED");
  expect(JSON.stringify(result)).not.toMatch(/private-secret|PRIVATE_SECRET/);
});

it.each([
  ["anthropic", {}],
  ["gemini", { GEMINI_AUTH_MODE: "api-key" }],
  ["gemini", { GEMINI_AUTH_MODE: "access-token", GEMINI_BASE_URL: "https://example.invalid" }],
  ["amazon-bedrock", { AWS_ACCESS_KEY_ID: "fixture-access-id" }],
] as const)("classifies actual %s credential-authority exceptions", (provider, env) => {
  const authority = resolveProviderCredentialAuthority(provider, {}, env);
  let error: unknown;
  try { requireProviderRuntimeCredential(provider, { ...authority, managedCredential: false }); }
  catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(LLMMissingCredentialsError);
  const result = telegramSessionFailure(error);
  expect(result.code).toBe("TELEGRAM_PROVIDER_CREDENTIAL_MISSING");
  expect(result.reply).toContain(provider);
  expect(result.reply).toContain("Settings");
  expect(result.diagnostic).toContain(provider);
  expect(JSON.stringify(result)).not.toContain("fixture-access-id");
});
it("never copies even a trusted credential exception's arbitrary secret-bearing message", () => {
  const result = telegramSessionFailure(new LLMMissingCredentialsError("anthropic", "Bearer private-secret"));
  expect(result.code).toBe("TELEGRAM_PROVIDER_CREDENTIAL_MISSING");
  expect(result.diagnostic).toContain("ANTHROPIC_AUTH_TOKEN");
  expect(JSON.stringify(result)).not.toContain("private-secret");
});
