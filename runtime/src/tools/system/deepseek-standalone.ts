/** Separate DeepSeek tool authority. Never borrow the reasoning model's key. */
import { readLocalByokCredential } from "../../auth/native-credentials.js";
import type { ToolsConfig } from "../../config/schema.js";
import { resolveProviderApiKeyEnvironment, resolveProviderBaseURLEnvironment } from "../../llm/registry/provider-ingress.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../llm/registry/provider-info.js";
import { deepSeekToolEndpoint } from "../../llm/providers/deepseek/tool-api.js";
import { type ToolCallAuthority, type ToolCallSessionRef } from "./session-provider-authority.js";

/** Child sessions use their own config, including an absent opt-in. */
export function standaloneToolsConfig(call: ToolCallSessionRef, captured?: Readonly<Record<string, unknown>>): ToolsConfig | undefined {
  const store = call.session?.services?.configStore;
  if (store !== undefined) {
    return (store.current() as { tools_config?: ToolsConfig }).tools_config;
  }
  return call.registrySession ? captured as ToolsConfig | undefined : undefined;
}

export function resolveStandaloneDeepSeek(
  authority: ToolCallAuthority,
  call: ToolCallSessionRef,
  api: "search" | "fetch" | "ocr",
): { endpoint: string; apiKey: string } | { error: string } {
  try {
    const configured = call.session?.services?.configStore?.current() as
      { providers?: { deepseek?: { base_url?: string } } } | undefined;
    const baseURL = resolveProviderBaseURLEnvironment("deepseek", authority.environment)?.value ??
      configured?.providers?.deepseek?.base_url ?? BUILT_IN_PROVIDER_BASE_URLS.deepseek;
    const parsed = new URL(baseURL);
    // Plain HTTP is only for an explicitly configured loopback recorder/proxy.
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        (parsed.protocol !== "https:" && !(parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)))) {
      return { error: "DeepSeek tools require an HTTPS base URL (HTTP is allowed only on loopback)." };
    }
    const apiKey = resolveProviderApiKeyEnvironment("deepseek", authority.environment)?.value ??
      (authority.credentialHome === undefined ? undefined : readLocalByokCredential(authority.credentialHome, "deepseek")?.apiKey);
    if (!apiKey?.trim()) return { error: "DeepSeek tools require a DeepSeek API key configured through /providers or DEEPSEEK_API_KEY." };
    const endpoint = deepSeekToolEndpoint(baseURL, api);
    return endpoint === undefined ? { error: "Invalid DeepSeek tool base URL." } : { endpoint, apiKey };
  } catch {
    // Credential storage and URL errors can contain sensitive material.
    return { error: "Could not resolve this session's DeepSeek tool credentials or endpoint." };
  }
}
