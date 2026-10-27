import { useEffect, useRef, useState } from "react";
import type { SlashCommandContext } from "../../commands/types.js";
import { ensureLiveModelCatalog } from "../../commands/live-model-catalog.js";

/** The footer needs the same published effort data as /effort, before any menu opens. */
export function useSessionEffortCatalog(
  session: unknown,
  provider: string,
  model: string,
  getContext: () => SlashCommandContext,
): number {
  const context = useRef(getContext);
  context.current = getContext;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (provider !== "venice" && provider !== "ollama-cloud" && provider !== "openrouter") return;
    let active = true;
    void ensureLiveModelCatalog(context.current(), provider, model).then(() => {
      if (active) setRevision(value => value + 1);
    }).catch(() => { /* Offline: keep the bundled model's label. */ });
    return () => { active = false; };
  }, [session, provider, model]);
  return revision;
}
