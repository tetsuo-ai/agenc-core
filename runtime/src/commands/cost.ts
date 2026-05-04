import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export function formatCostSummary(session: Session): string {
  const sidecar = session.services.costSidecar;
  if (!sidecar) {
    return "Cost tracking is not enabled for this session.";
  }
  return sidecar.formatSummary();
}

export const costCommand: SlashCommand = {
  name: "cost",
  description: "Show the current session cost summary",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({ kind: "text", text: formatCostSummary(ctx.session) })),
};

export default costCommand;
