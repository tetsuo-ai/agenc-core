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
const CLEAR_ARGS = new Set(["auto", "unset", "none"]);
const STATUS_ARGS = new Set(["", "current", "status"]);
const HELP_ARGS = new Set(["help", "--help", "-h"]);

export function parseEffort(value: string): ReasoningEffort | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "max") return "xhigh";
  return VALID_EFFORTS.has(normalized as ReasoningEffort)
    ? (normalized as ReasoningEffort)
    : null;
}

export function readReasoningEffort(session: Session): ReasoningEffort | null {
  const state = session.state.unsafePeek() as {
    sessionConfiguration?: {
      collaborationMode?: { reasoningEffort?: ReasoningEffort };
    };
  };
  return state.sessionConfiguration?.collaborationMode?.reasoningEffort ?? null;
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

export async function clearReasoningEffort(session: Session): Promise<string> {
  let previous = "unset";
  await session.state.with((state) => {
    const cfg = state.sessionConfiguration as {
      collaborationMode: { model: string; reasoningEffort?: ReasoningEffort };
    };
    previous = cfg.collaborationMode.reasoningEffort ?? "unset";
    const { reasoningEffort: _reasoningEffort, ...rest } = cfg.collaborationMode;
    cfg.collaborationMode = rest;
  });
  return `Reasoning effort reset to model default (was ${previous}).`;
}

export function formatReasoningEffortStatus(session: Session): string {
  return `Current reasoning effort: ${readReasoningEffort(session) ?? "model default"}.`;
}

function effortHelpText(): string {
  return "Usage: /effort [current|status|auto|unset|minimal|low|medium|high|xhigh|max]";
}

export const effortCommand: SlashCommand = {
  name: "effort",
  description: "Set or show reasoning effort for subsequent turns",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const arg = ctx.argsRaw.trim().toLowerCase();
      if (STATUS_ARGS.has(arg)) {
        return { kind: "text", text: formatReasoningEffortStatus(ctx.session) };
      }
      if (HELP_ARGS.has(arg)) {
        return { kind: "text", text: effortHelpText() };
      }
      if (CLEAR_ARGS.has(arg)) {
        return { kind: "text", text: await clearReasoningEffort(ctx.session) };
      }

      const effort = parseEffort(arg);
      if (effort === null) {
        return {
          kind: "error",
          message: effortHelpText(),
        };
      }
      return {
        kind: "text",
        text: await applyReasoningEffort(ctx.session, effort),
      };
    }),
};

export default effortCommand;
