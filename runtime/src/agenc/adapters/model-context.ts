import type { TurnContext } from "../../session/turn-context.js";
import { modelContextWindow } from "../../session/turn-context.js";

export interface AgenCModelContext {
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

export function toAgenCModelContext(ctx: TurnContext): AgenCModelContext {
  const contextWindowTokens = modelContextWindow(ctx) ?? ctx.modelInfo.contextWindow;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    throw new Error(`Missing context window for model ${ctx.modelInfo.slug}`);
  }
  return {
    model: ctx.modelInfo.slug,
    contextWindowTokens,
    ...(ctx.modelInfo.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.modelInfo.maxOutputTokens }
      : {}),
  };
}
