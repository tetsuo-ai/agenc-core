import type { Command } from "../../commands.js";

type LocalJsxCommandModule = Awaited<
  ReturnType<Extract<Command, { type: "local-jsx" }>["load"]>
>;

/**
 * Legacy local-JSX adapter for old command loaders.
 *
 * The runtime slash registry owns `/memory`; this descriptor only points
 * older local-JSX loading paths at the v2 memory command body.
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
