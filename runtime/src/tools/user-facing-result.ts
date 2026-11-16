/**
 * User-facing replacements for tool results whose text is written for the
 * model. One table for every client: the daemon applies it to the live tool
 * events it sends (desktop app, SDK clients, TUI) and the TUI applies the
 * same rules when it rebuilds a transcript from stored events.
 *
 * The model's copy of the result never passes through here.
 *
 * Pure module: no TUI, provider or registry imports.
 */
import {
  askUserQuestionErrorDisplay,
  formatAskUserQuestionDisplay,
  isAskUserQuestionModelText,
  QUESTIONS_ANSWERED_TEXT,
  resolveAskUserQuestionDisplay,
} from "./ask-user-question/display.js";

export const ENTERED_PLAN_MODE_TEXT = "Entered plan mode";
export const PLAN_MODE_ALREADY_ACTIVE_TEXT = "Plan mode is already active";

/** One-line receipt for a Skill load (the result is the whole skill prompt). */
export function skillLoadReceipt(raw: string): string | undefined {
  const name = /<command-name>([^<]{1,120})<\/command-name>/.exec(raw)?.[1];
  return name === undefined
    ? undefined
    : `Loaded skill ${name} (${raw.length} chars of instructions, hidden from chat)`;
}

/**
 * ExitPlanMode answers the model in the third person ("User has approved
 * your plan. You can now start coding. ...", "User wants you to keep
 * planning. Remain in plan mode, ..."). The user sees their own decision.
 */
export function exitPlanModeReceipt(raw: string): string | undefined {
  const text = raw.trimStart();
  if (text.startsWith("User has approved your plan.")) {
    return text.includes("## Approved Plan (edited by user):")
      ? "Plan approved with your edits"
      : "Plan approved";
  }
  if (text.startsWith("User has approved exiting plan mode.")) return "Left plan mode";
  if (text.startsWith("User wants you to keep planning.")) return "Keep planning";
  const changes = /^User wants changes before approving the plan:\n\n([\s\S]*?)\n\nRemain in plan mode, revise the plan file, then call ExitPlanMode again\.\s*$/u.exec(text);
  if (changes !== null) return `Changes requested: ${changes[1]!.trim()}`;
  return undefined;
}

/**
 * request_user_input returns its answers to the model as raw JSON
 * (`{"answers":{"q1":{"answers":["yes"]}}}`). The user sees the answers.
 */
export function requestUserInputReceipt(raw: string): string | undefined {
  if (!raw.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const answers = (parsed as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return undefined;
  const given: string[] = [];
  for (const entry of Object.values(answers as Record<string, unknown>)) {
    const list = (entry as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && item.trim().length > 0) given.push(item.trim());
    }
  }
  return given.length > 0 ? `Answered: ${given.join("; ")}` : "Answered";
}

/**
 * The runtime closes a tool call the provider never finished with an error
 * whose text instructs the model ("Retry a complete tool call; for
 * spawn_agent use message_ref instead of copying context."). The user reads
 * what happened.
 */
export function unfinishedToolCallNotice(result: unknown): string | undefined {
  let parsed: unknown = result;
  if (typeof result === "string") {
    if (!result.trimStart().startsWith("{")) return undefined;
    try {
      parsed = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.executed !== false) return undefined;
  if (record.code === "tool_arguments_truncated") {
    return "The model's tool call was cut off by the output limit and did not run. The model will retry.";
  }
  if (record.code === "malformed_tool_call") {
    return "The model sent an incomplete tool call and it did not run. The model will retry.";
  }
  return undefined;
}

/**
 * Returns the text a user should see for this tool result, or undefined when
 * the result is already fit to show (the caller keeps it as is).
 */
export function userFacingToolResultText(input: {
  readonly toolName?: string;
  readonly result: unknown;
  readonly metadata?: unknown;
  readonly isError?: boolean;
  /** The call's `questions` input, when the caller has it (AskUserQuestion). */
  readonly questions?: unknown;
}): string | undefined {
  const { toolName, result } = input;
  if (toolName === "AskUserQuestion") {
    if (input.isError === true) return askUserQuestionErrorDisplay(result) ?? undefined;
    const display = resolveAskUserQuestionDisplay({
      result,
      metadata: input.metadata,
      questions: input.questions,
    });
    if (display !== null) return formatAskUserQuestionDisplay(display);
    return typeof result === "string" && isAskUserQuestionModelText(result)
      ? QUESTIONS_ANSWERED_TEXT
      : undefined;
  }
  if (input.isError === true) return undefined;
  if (toolName === "EnterPlanMode") {
    return typeof result === "string" && result.trimStart().startsWith("Already in plan mode")
      ? PLAN_MODE_ALREADY_ACTIVE_TEXT
      : ENTERED_PLAN_MODE_TEXT;
  }
  if (toolName === "ExitPlanMode" && typeof result === "string") return exitPlanModeReceipt(result);
  if (toolName === "Skill" && typeof result === "string") return skillLoadReceipt(result);
  if (toolName === "request_user_input" && typeof result === "string") return requestUserInputReceipt(result);
  return undefined;
}
