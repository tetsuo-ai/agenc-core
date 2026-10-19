import type { SlashCommand } from "./types.js";

export const updateCommand: SlashCommand = {
  name: "update",
  description: "Check for an AgenC update and choose whether to install it",
  immediate: true,
  async execute(ctx) {
    try {
      const { openUpdateMenu } = await import("./update-menu.js");
      if (openUpdateMenu(ctx)) return { kind: "skip" };
      const { checkAgenCUpdate } = await import("../bin/update-cli.js");
      const { detectHomebrew, HOMEBREW_UPDATE_COMMAND } = await import("../utils/nativeInstaller/homebrew.js");
      const result = await checkAgenCUpdate(undefined, { manifestTimeoutMs: 3000 });
      const instruction = detectHomebrew() ? `Run ${HOMEBREW_UPDATE_COMMAND} in your terminal.` : "Run agenc update to install.";
      return { kind: "text", text: `Installed: ${result.currentVersion}. Latest: ${result.latestVersion}. ${result.updateAvailable ? instruction : "AgenC is up to date."}` };
    } catch (error) {
      const { sanitizeTerminalText } = await import("../bin/update-cli.js");
      return { kind: "error", message: `Could not check for updates: ${sanitizeTerminalText(error)}.` };
    }
  },
};
