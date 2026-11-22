import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * `/usage` shows every connected provider with a usage
 * API, fetched together. `/usage <provider>` shows one provider in detail.
 */
export const usageCommand: SlashCommand = {
  name: "usage",
  description: "Show connected provider usage and balances",
  argumentHint: "[provider]",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => executeUsageCommand(ctx),
};

async function executeUsageCommand(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  return safeExecute(async () => {
    const args = ctx.argsRaw.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (args.length > 1) {
      return { kind: "error", message: "Usage: /usage [provider]" };
    }
    const providerUsage = await import("./provider-usage.js");
    const [provider] = args;
    if (provider !== undefined) {
      return await providerUsage.readProviderUsageDetail(ctx, provider);
    }
    const providers = await providerUsage.readProviderUsageSection(ctx);
    return {
      kind: "text",
      text: providers,
    };
  });
}
