import type { Command } from "../../commands.js";

type LocalJsxCommandModule = Awaited<
  ReturnType<Extract<Command, { type: "local-jsx" }>["load"]>
>;

/**
 * Ports the TUI source reference `src/commands/memory/index.ts` command
 * descriptor onto AgenC's local JSX command surface.
 *
 * Why this lives here / shape difference from upstream:
 *   - The interactive command stays local-JSX so the TUI can render the
 *     memory-file selector instead of routing through a plain-text dispatcher.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None; the feature-gated memory folders remain inside the selector.
 */
const memoryCommand = {
  type: "local-jsx",
  name: "memory",
  description: "Edit AgenC memory files",
  load: async (): Promise<LocalJsxCommandModule> => {
    const mod = await import("./memory.js");
    return { call: mod.call as unknown as LocalJsxCommandModule["call"] };
  },
} satisfies Command;

export default memoryCommand;
