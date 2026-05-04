import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../../commands/types.js";
import {
  runAgenCContextUsage,
  runAgenCManualCompact,
} from "./runtime-session.js";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact the current conversation",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      await ensureNoActiveTurn(ctx);
      const turnContext = ctx.session.newDefaultTurnWithSubId(
        ctx.session.nextInternalSubId(),
      );
      if (!turnContext) {
        return { kind: "error", message: "No turn context is available." };
      }
      const result = await runAgenCManualCompact({
        session: ctx.session,
        ctx: turnContext,
        customInstructions: ctx.argsRaw,
      });
      return {
        kind: "compact",
        text: result.displayText,
      };
    }),
};

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show current context usage",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const turnContext = ctx.session.newDefaultTurnWithSubId(
        ctx.session.nextInternalSubId(),
      );
      if (!turnContext) {
        return { kind: "error", message: "No turn context is available." };
      }
      const result = await runAgenCContextUsage({
        session: ctx.session,
        ctx: turnContext,
        args: ctx.argsRaw,
      });
      return {
        kind: "text",
        text: result.text,
      };
    }),
};

async function ensureNoActiveTurn(ctx: SlashCommandContext): Promise<void> {
  const activeTurn = (ctx.session as unknown as {
    activeTurn?: { unsafePeek?: () => unknown };
  }).activeTurn;
  if (activeTurn?.unsafePeek?.() != null) {
    throw new Error(
      "Cannot compact right now: a turn is currently in flight; wait for it to complete before running /compact.",
    );
  }
}
