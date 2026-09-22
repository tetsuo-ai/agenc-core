import { describe, expect, test, vi } from "vitest";
import { createProvider, readProviderFactoryOptions } from "./provider.js";
import { resolveProviderRuntimeAuthority, resolveProviderFactoryOptions } from "./provider-options.js";
import { ClaudeSubscriptionProvider, prepareRequest, parseResponse, wireName } from "./providers/claude-subscription/adapter.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";

describe("experimental Claude CLI provider ingress", () => {
  test("selects CLI auth without reading saved or managed API credentials", async () => {
    const readSavedApiKey = vi.fn();
    const authority = await resolveProviderRuntimeAuthority("anthropic", { model: "claude-sonnet-5" }, {
      AGENC_EXPERIMENTAL_CLAUDE_SUBSCRIPTION: "1", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/private/claude",
      UNRELATED_SECRET: "must-not-propagate",
    }, { readSavedApiKey, managedKeysEnabled: true });
    expect(authority.credential.status).toBe("not-required");
    expect(readSavedApiKey).not.toHaveBeenCalled();
    const provider = createProvider("anthropic", authority.factoryOptions);
    expect(provider).toBeInstanceOf(ClaudeSubscriptionProvider);
    expect(readProviderFactoryOptions(provider)?.extra?.claudeSubscription).toBe(true);
    expect(authority.factoryOptions.extra?.claudeSubscriptionEnvironment).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/private/claude" });
    const withAccountBackend = createProvider("anthropic", { ...authority.factoryOptions, extra: {
      ...authority.factoryOptions.extra, sessionId: "fixture-session", authBackend: {
        login: vi.fn(), logout: vi.fn(), whoami: vi.fn(), vendKey: vi.fn(),
      },
    } });
    expect(withAccountBackend).toBeInstanceOf(ClaudeSubscriptionProvider);
    withAccountBackend.dispose?.();
    provider.dispose?.();
  });

  test("the default Anthropic route remains the ordinary API adapter", () => {
    const options = resolveProviderFactoryOptions("anthropic", { model: "claude-sonnet-5" }, { ANTHROPIC_API_KEY: "fixture-api-key" });
    expect(createProvider("anthropic", options)).toBeInstanceOf(AnthropicProvider);
  });

  test("explicit mixed credentials and endpoint overrides are rejected without exposing values", () => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(() => resolveProviderFactoryOptions("anthropic", {}, { AGENC_EXPERIMENTAL_CLAUDE_SUBSCRIPTION: "1", [key]: "private-sentinel" })).toThrow(/cannot be combined/);
    }
    expect(() => createProvider("anthropic", { apiKey: "fixture", extra: { claudeSubscription: true } })).toThrow(/rejects API credentials/);
  });

  test("runtime tool allowlists and none choice narrow both advertisement and response acceptance", () => {
    const tools = [{ type: "function" as const, function: { name: "exec_command", description: "shell", parameters: {} } }];
    const request = prepareRequest("sonnet", [{ role: "user", content: "hi" }], { tools, toolRouting: { allowedToolNames: [] } });
    expect(request.tools).toEqual([]);
    expect(prepareRequest("sonnet", [{ role: "user", content: "hi" }], { tools, toolChoice: "none" }).tools).toEqual([]);
    expect(() => parseResponse({ model: "sonnet", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "id", function: { name: wireName("exec_command"), arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, native_admission: { upstream_requests: 1, blocked_requests: 0 } } }, request, { tools })).toThrow(/Unadvertised/);
  });
});
