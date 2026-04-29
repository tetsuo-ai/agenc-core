import type { ToolDispatchResult } from "../tool-registry.js";

export function markLoadedToolNamesDiscovered(
  toolName: string,
  result: ToolDispatchResult,
  discovered: ReadonlySet<string> | undefined,
): void {
  if (toolName !== "system.searchTools" || result.isError === true) return;
  if (!discovered || typeof (discovered as Set<string>).add !== "function") {
    return;
  }
  try {
    const parsed = JSON.parse(result.content) as { loaded?: unknown };
    if (!Array.isArray(parsed.loaded)) return;
    for (const name of parsed.loaded) {
      if (typeof name === "string" && name.trim().length > 0) {
        (discovered as Set<string>).add(name);
      }
    }
  } catch {
    // The model-facing result has already been recorded; discovery is
    // best-effort for the next provider request.
  }
}
