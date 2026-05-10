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
    return (
      "Cost tracking is not yet wired through the daemon bridge. " +
      "The daemon-owned session tracks usage internally; the TUI " +
      "doesn't surface it. Use `agenc usage` from another shell, " +
      "or `/usage` for the per-session token snapshot."
    );
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
