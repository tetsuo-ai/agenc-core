import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./types.js";
import { parseRemoteSlashArgs, runRemoteSlash, startRemoteOn } from "../bin/remote-cli.js";
import { remoteAuthContextFromCommandContext } from "./config-context.js";

/**
 * `/remote [on|off|status]` — link this computer to the AgenC phone app from inside an agent session.
 * `on` shows a code + QR as a PERSISTENT surface (it does not vanish after a few seconds) and
 * auto-closes the moment the phone pairs. `status`/`off` inspect or forget the pairing.
 */
export const remoteCommand: SlashCommand = {
  name: "remote",
  description: "Link this computer to the AgenC phone app",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx: SlashCommandContext): Promise<SlashCommandResult> => {
    const { sub, fullControl } = parseRemoteSlashArgs(ctx.argsRaw);
    const runtimeContext = remoteAuthContextFromCommandContext(ctx);
    if (sub !== "on") {
      return {
        kind: "text",
        text: await runRemoteSlash(ctx.argsRaw, runtimeContext),
      };
    }

    const started = await startRemoteOn(runtimeContext, { fullControl });
    if ("message" in started) {
      return { kind: "text", text: started.message };
    }

    const shown = typeof ctx.appState?.setToolJSX === "function" &&
      (await import("./remote-menu.js")).openRemotePairMenu(ctx, started);
    if (!shown) {
      // Headless / no TUI surface — fall back to plain text.
      return { kind: "text", text: started.box };
    }
    return { kind: "skip" };
  },
};
