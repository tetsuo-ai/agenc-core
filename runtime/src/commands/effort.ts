import type { ReasoningEffort } from "../config/schema.js";
import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

const VALID_EFFORTS = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function parseEffort(value: string): ReasoningEffort | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "max") return "xhigh";
  return VALID_EFFORTS.has(normalized as ReasoningEffort)
    ? (normalized as ReasoningEffort)
    : null;
}

export async function applyReasoningEffort(
  session: Session,
  effort: ReasoningEffort,
): Promise<string> {
  let previous = "unset";
  await session.state.with((state) => {
    const cfg = state.sessionConfiguration as {
      collaborationMode: { model: string; reasoningEffort?: ReasoningEffort };
    };
    previous = cfg.collaborationMode.reasoningEffort ?? "unset";
    cfg.collaborationMode = {
      ...cfg.collaborationMode,
      reasoningEffort: effort,
    };
  });
  return `Reasoning effort set to ${effort} (was ${previous}).`;
}

export const effortCommand: SlashCommand = {
  name: "effort",
  description: "Set reasoning effort for subsequent turns",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const effort = parseEffort(ctx.argsRaw);
      if (effort === null) {
        return {
          kind: "error",
          message: "Usage: /effort <minimal|low|medium|high|xhigh|max>",
        };
      }
      return {
        kind: "text",
        text: await applyReasoningEffort(ctx.session, effort),
      };
    }),
};

export default effortCommand;
