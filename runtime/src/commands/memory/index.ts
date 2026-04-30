import type { SlashCommand } from "../types.js";

const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Open AgenC memory management",
  immediate: true,
  async execute() {
    return {
      kind: "text",
      text: "AgenC memory is managed by the upstream-derived memory surface.",
    };
  },
};

export default memoryCommand;
