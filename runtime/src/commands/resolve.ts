/**
 * /resolve — operator review of unknown-outcome tool effects (the M4 gate).
 *
 * A tool call that dies mid-dispatch (timeout, crash) leaves an "unknown
 * outcome" effect, and the M4 gate then blocks every later side-effecting
 * call in the session until an operator reviews it. The CLI path
 * (`agenc state resolve-tool-call`) cannot run while the daemon holds the
 * session lock — this command resolves through the live daemon instead.
 *
 * Usage: /resolve            — resolve every pending unknown-outcome effect
 *        /resolve <call-id>  — resolve one specific effect
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandResult,
} from "./types.js";

type ResolvableSession = {
  readonly resolveDaemonToolCall?: (params: {
    readonly toolCallId?: string;
    readonly reviewer?: string;
  }) => Promise<{
    readonly sessionId: string;
    readonly resolved: readonly {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly eventId?: string;
    }[];
    readonly remaining: number;
  }>;
};

export const resolveCommand: SlashCommand = {
  name: "resolve",
  aliases: ["resolve-effects"],
  description: "Resolve blocked tool effects (M4 gate)",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const session = ctx.session as unknown as ResolvableSession;
      if (typeof session.resolveDaemonToolCall !== "function") {
        return {
          kind: "error",
          message:
            "This session cannot resolve effects here — close the session and run `agenc state resolve-tool-call <session-id> <tool-call-id>` from the project directory.",
        };
      }
      const toolCallId = ctx.argsRaw.trim() || undefined;
      const result = await session.resolveDaemonToolCall({
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        reviewer: "tui_operator",
      });
      if (result.resolved.length === 0) {
        return {
          kind: "text",
          text: toolCallId !== undefined
            ? `No pending unknown-outcome effect '${toolCallId}' in this session (nothing blocked).`
            : "No pending unknown-outcome effects — the session is not blocked.",
        };
      }
      const lines = result.resolved.map(
        (effect) =>
          `  ✔ ${effect.toolCallId}${effect.toolName ? ` (${effect.toolName})` : ""}`,
      );
      lines.push(
        result.remaining === 0
          ? "Mutation gate lifted — side-effecting tools are unblocked."
          : `${result.remaining} unknown-outcome effect(s) still pending.`,
      );
      return { kind: "text", text: lines.join("\n") };
    }),
};
