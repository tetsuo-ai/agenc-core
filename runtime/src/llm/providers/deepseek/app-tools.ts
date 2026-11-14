import { resolveWebSearchMode } from "../../../tools/web-search-mode.js";
import type { AgenCConfig } from "../../../config/schema.js";

export const DEEPSEEK_APP_TOOLS_ENV = "AGENC_DEEPSEEK_APP_TOOLS";

export function supportsDeepSeekAppTools(provider: string | undefined, model: string): boolean {
  return provider === "deepseek" &&
    ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model);
}

/** Both switches belong to the session. Never read the process environment here. */
export function deepSeekAppToolsEnabled(
  provider: string | undefined,
  model: string,
  environment: Readonly<Record<string, string | undefined>>,
  config?: Pick<AgenCConfig, "web_search" | "providers">,
): boolean {
  if (!supportsDeepSeekAppTools(provider, model) ||
      resolveWebSearchMode(environment, config?.web_search) !== "on") return false;
  const value = environment[DEEPSEEK_APP_TOOLS_ENV]?.trim().toLowerCase();
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return config?.providers?.deepseek?.app_tools === true;
}

export const DEEPSEEK_APP_TOOLS_INSTRUCTION =
  "Use deepseek_web_search to search the web and deepseek_read_url to read links in user messages. " +
  "These tools run on the provider. Use their cited sources in your answer. Local functions remain available for coding work.";
