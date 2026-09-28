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
