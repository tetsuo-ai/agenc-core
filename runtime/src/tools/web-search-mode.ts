/** Manual web access is opt-in; Auto preserves deferred tool discovery. */
export type WebSearchMode = "auto" | "on";
export const WEB_SEARCH_MODE_ENV = "AGENC_WEB_SEARCH";
export const WEB_SEARCH_ON_INSTRUCTION =
  "Use WebSearch to find web information and web_fetch to read pages, instead of curl or wget through the shell.";

export function resolveWebSearchMode(
  env: Readonly<Record<string, string | undefined>>,
  configured?: WebSearchMode,
): WebSearchMode {
  const value = env[WEB_SEARCH_MODE_ENV]?.trim().toLowerCase();
  return value === "on" || value === "auto" ? value : configured ?? "auto";
}

export const WEB_SEARCH_INITIAL_TOOLS: ReadonlySet<string> = new Set(["WebSearch", "web_fetch"]);

/** Refresh the trusted base line when the picker changes during a session. */
export function applyWebSearchInstruction(base: string, mode: WebSearchMode): string {
  const parts = base.split("\n\n").filter(part => part !== WEB_SEARCH_ON_INSTRUCTION);
  if (mode === "on") parts.push(WEB_SEARCH_ON_INSTRUCTION);
  return parts.join("\n\n");
}
