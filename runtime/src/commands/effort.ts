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
  // Bridge sessions (TUI client → daemon) don't expose `state`; fall
  // back to the sessionConfiguration carried directly on the session.
  const peekState = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const stateConfig = (typeof peekState === "function"
    ? (peekState.call((session as unknown as { state?: unknown }).state) as {
        sessionConfiguration?: {
          collaborationMode?: { reasoningEffort?: ReasoningEffort };
        };
      })
    : null)?.sessionConfiguration;
  const directConfig = (session as unknown as {
    sessionConfiguration?: {
      collaborationMode?: { reasoningEffort?: ReasoningEffort };
    };
  }).sessionConfiguration;
  return (
    stateConfig?.collaborationMode?.reasoningEffort ??
    directConfig?.collaborationMode?.reasoningEffort ??
    null
  );
}

function getStateLock(session: Session): Session["state"] | null {
  // Bridge sessions don't expose a state lock; only the in-process
  // Session can be mutated via /effort apply/clear today.
  const candidate = (session as unknown as { state?: Session["state"] }).state;
  if (
    candidate !== undefined &&
    candidate !== null &&
    typeof (candidate as { with?: unknown }).with === "function"
  ) {
    return candidate;
  }
  return null;
}

export async function applyReasoningEffort(
  session: Session,
  effort: ReasoningEffort,
): Promise<string> {
  const lock = getStateLock(session);
  if (lock === null) {
    return "Reasoning-effort changes from the TUI are not supported when running against the daemon. Set `reasoning_effort` in config.toml or via the model picker.";
  }
  let previous = "unset";
  await lock.with((state) => {
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
  const lock = getStateLock(session);
  if (lock === null) {
    return "Reasoning-effort changes from the TUI are not supported when running against the daemon. Set `reasoning_effort` in config.toml or via the model picker.";
  }
  let previous = "unset";
  await lock.with((state) => {
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
