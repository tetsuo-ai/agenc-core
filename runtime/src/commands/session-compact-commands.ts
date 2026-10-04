import { safeExecute, type SlashCommand } from "./types.js";

// Registry lookup needs only these descriptors. Load compaction and context
// projection at execution time, including import failures in the command's
// ordinary error-result boundary.
export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact the current conversation",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: ctx => safeExecute(async () => {
    const { executeCompactCommand } = await import("./session-compact.js");
    return executeCompactCommand(ctx);
  }),
};

export const contextCommand: SlashCommand = {
  name: "context",
  aliases: ["ctx"],
  description: "Show current context usage",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: ctx => safeExecute(async () => {
    const { executeContextCommand } = await import("./session-compact.js");
    return executeContextCommand(ctx);
  }),
};
