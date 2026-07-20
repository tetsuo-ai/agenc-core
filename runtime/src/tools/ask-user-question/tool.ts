/**
 * Model-facing tool for asking 1-4 multiple-choice questions during planning
 * or execution. The TUI renders the interactive picker and records the user's
 * answers before allowing the tool call to run.
 */

import type { PermissionResult } from "../../permissions/types.js";
import { asRecord } from "../../utils/record.js";
import type { Tool } from "../types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const CALL_ID_ARG = "__callId";

export interface AskUserQuestionOption {
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
}

export interface AskUserQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly AskUserQuestionOption[];
  readonly multiSelect?: boolean;
}

export interface AskUserQuestionAnnotation {
  readonly preview?: string;
  readonly notes?: string;
}

export interface AskUserQuestionInput {
  readonly questions: readonly AskUserQuestion[];
  readonly answers?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, AskUserQuestionAnnotation>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AskUserQuestionPlanInterviewAction =
  | "chat_about_this"
  | "skip_plan_interview";

export type AskUserQuestionParseResult =
  | { readonly ok: true; readonly input: AskUserQuestionInput }
  | { readonly ok: false; readonly error: string };

const answeredInputs = new Map<string, AskUserQuestionInput>();

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseAnswers(value: unknown): Readonly<Record<string, string>> | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, answer] of Object.entries(record)) {
    if (typeof answer === "string") {
      out[key] = answer;
    }
  }
  return out;
}

function parseAnnotations(
  value: unknown,
): Readonly<Record<string, AskUserQuestionAnnotation>> | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const out: Record<string, AskUserQuestionAnnotation> = {};
  for (const [key, raw] of Object.entries(record)) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const preview = typeof entry.preview === "string" ? entry.preview : undefined;
    const notes = typeof entry.notes === "string" ? entry.notes : undefined;
    if (preview !== undefined || notes !== undefined) {
      out[key] = {
        ...(preview !== undefined ? { preview } : {}),
        ...(notes !== undefined ? { notes } : {}),
      };
    }
  }
  return out;
}

export function parseAskUserQuestionInput(
  value: unknown,
): AskUserQuestionParseResult {
  const record = asRecord(value);
  if (record === null) {
    return { ok: false, error: "input must be an object" };
  }
  if (!Array.isArray(record.questions)) {
    return { ok: false, error: "questions must be an array" };
  }
  if (record.questions.length < 1 || record.questions.length > 4) {
    return { ok: false, error: "questions must contain 1-4 items" };
  }

  const questions: AskUserQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const [questionIndex, rawQuestion] of record.questions.entries()) {
    const questionRecord = asRecord(rawQuestion);
    if (questionRecord === null) {
      return { ok: false, error: `questions[${questionIndex}] must be an object` };
    }
    const question = nonEmptyString(questionRecord.question);
    const header = nonEmptyString(questionRecord.header);
    if (question === null) {
      return { ok: false, error: `questions[${questionIndex}].question is required` };
    }
    if (header === null) {
      return { ok: false, error: `questions[${questionIndex}].header is required` };
    }
    if (seenQuestions.has(question)) {
      return { ok: false, error: "question texts must be unique" };
    }
    seenQuestions.add(question);
    if (!Array.isArray(questionRecord.options)) {
      return { ok: false, error: `questions[${questionIndex}].options must be an array` };
    }
    if (questionRecord.options.length < 2 || questionRecord.options.length > 4) {
      return {
        ok: false,
        error: `questions[${questionIndex}].options must contain 2-4 items`,
      };
    }
    const seenLabels = new Set<string>();
    const options: AskUserQuestionOption[] = [];
    for (const [optionIndex, rawOption] of questionRecord.options.entries()) {
      const optionRecord = asRecord(rawOption);
      if (optionRecord === null) {
        return {
          ok: false,
          error: `questions[${questionIndex}].options[${optionIndex}] must be an object`,
        };
      }
      const label = nonEmptyString(optionRecord.label);
      const preview = nonEmptyString(optionRecord.preview);
      // Models are split on which field carries the option detail: Claude
      // sends `description`, Grok sends `preview` — or, most often, a bare
      // `label` alone (observed repeatedly in the wild). Rejecting the
      // label-only shape just loops the model into the same invalid call,
      // so the description falls back to the label itself: the picker shows
      // the label prominently either way and the detail line simply drops.
      const description =
        nonEmptyString(optionRecord.description) ?? preview ?? label;
      if (label === null) {
        return {
          ok: false,
          error: `questions[${questionIndex}].options[${optionIndex}].label is required`,
        };
      }
      if (description === null) {
        return {
          ok: false,
          error: `questions[${questionIndex}].options[${optionIndex}] needs a label with text`,
        };
      }
      if (seenLabels.has(label)) {
        return {
          ok: false,
          error: `option labels must be unique within question "${question}"`,
        };
      }
      seenLabels.add(label);
      options.push({
        label,
        description,
        ...(preview !== null ? { preview } : {}),
      });
    }
    questions.push({
      question,
      header,
      options,
      ...(questionRecord.multiSelect === true ? { multiSelect: true } : {}),
    });
  }

  const answers = parseAnswers(record.answers);
  const annotations = parseAnnotations(record.annotations);
  const metadata = asRecord(record.metadata);

  return {
    ok: true,
    input: {
      questions,
      ...(answers !== undefined ? { answers } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
      ...(metadata !== null ? { metadata } : {}),
    },
  };
}

export function recordAskUserQuestionResponse(
  callId: string,
  input: AskUserQuestionInput,
): void {
  if (callId.trim().length === 0) return;
  answeredInputs.set(callId, input);
}

export function recordAskUserQuestionUpdatedInput(
  callId: string,
  value: unknown,
): boolean {
  const parsed = parseAskUserQuestionInput(value);
  if (!parsed.ok) return false;
  recordAskUserQuestionResponse(callId, parsed.input);
  return true;
}

/**
 * Retrieve (and remove) the answers recorded for a call — used by the daemon
 * bridge to ship the user's answers with the `tool.approve` RPC so the
 * daemon-side tool execution finds them in ITS answeredInputs map. Mirrors
 * takePlanApprovalChoice for ExitPlanMode.
 */
export function takeAskUserQuestionUpdatedInput(
  callId: string,
): AskUserQuestionInput | null {
  if (callId.trim().length === 0) return null;
  const answered = answeredInputs.get(callId);
  if (answered === undefined) return null;
  answeredInputs.delete(callId);
  return answered;
}

/**
 * Drop a recorded response without consuming it — used when the tool call it
 * was recorded for will never execute (e.g. the approval RPC raced an
 * already-resolved request), so the entry cannot leak in the map.
 */
export function dropAskUserQuestionResponse(callId: string): void {
  answeredInputs.delete(callId);
}

export function recordAskUserQuestionPlanInterviewAction(
  callId: string,
  value: unknown,
  action: AskUserQuestionPlanInterviewAction,
): boolean {
  const parsed = parseAskUserQuestionInput(value);
  if (!parsed.ok) return false;
  recordAskUserQuestionResponse(callId, {
    ...parsed.input,
    metadata: {
      ...(parsed.input.metadata ?? {}),
      planInterviewAction: action,
    },
  });
  return true;
}

export function clearAskUserQuestionResponsesForTest(): void {
  answeredInputs.clear();
}

function consumeAnsweredInput(
  args: Record<string, unknown>,
): AskUserQuestionInput | null {
  const callId = typeof args[CALL_ID_ARG] === "string" ? args[CALL_ID_ARG] : "";
  if (callId.length === 0) return null;
  const answered = answeredInputs.get(callId);
  answeredInputs.delete(callId);
  return answered ?? null;
}

function formatAnswers(
  answers: Readonly<Record<string, string>>,
  annotations: Readonly<Record<string, AskUserQuestionAnnotation>> | undefined,
): string {
  return Object.entries(answers)
    .map(([question, answer]) => {
      const annotation = annotations?.[question];
      const parts = [`"${question}"="${answer}"`];
      if (annotation?.preview) {
        parts.push(`selected preview:\n${annotation.preview}`);
      }
      if (annotation?.notes) {
        parts.push(`user notes: ${annotation.notes}`);
      }
      return parts.join(" ");
    })
    .join(", ");
}

function specialPlanInterviewAction(
  input: AskUserQuestionInput,
): AskUserQuestionPlanInterviewAction | null {
  const action = input.metadata?.planInterviewAction;
  return action === "chat_about_this" || action === "skip_plan_interview"
    ? action
    : null;
}

const DESCRIPTION =
  "Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions, or offer choices.";

const PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input.
- Use multiSelect: true to allow multiple answers to be selected for a question.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
- In plan mode, use this tool to clarify requirements or choose between approaches before finalizing your plan.
- Do not use this tool to ask if the plan is ready or whether you should proceed. Use ExitPlanMode for plan approval.`;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string" },
          header: { type: "string" },
          multiSelect: { type: "boolean" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              // Only label is hard-required here: `description` OR `preview`
              // carries the detail (the parser accepts either — Grok sends
              // preview, other models description). Requiring description in
              // the wire schema made provider-side validation reject calls
              // the parser would have accepted.
              required: ["label"],
              properties: {
                label: { type: "string" },
                description: { type: "string" },
                preview: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  required: ["questions"],
} as const;

export function createAskUserQuestionTool(): Tool {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: `${DESCRIPTION}\n\n${PROMPT}`,
    inputSchema,
    metadata: {
      family: "planning",
      source: "builtin",
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
      preferredProfiles: ["coding", "general", "operator"],
      keywords: ["ask", "question", "choice", "plan", "clarify"],
    },
    isReadOnly: true,
    requiresApproval: true,
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    requiresUserInteraction: () => true,
    recoveryCategory: "interactive",
    checkPermissions(): PermissionResult {
      return {
        behavior: "ask",
        message: "Answer questions?",
        decisionReason: {
          type: "permissionPromptTool",
          permissionPromptToolName: ASK_USER_QUESTION_TOOL_NAME,
          toolResult: null,
        },
      };
    },
    async execute(args) {
      const parsed = parseAskUserQuestionInput(args);
      if (!parsed.ok) {
        return { content: parsed.error, isError: true };
      }
      const answered = consumeAnsweredInput(args);
      if (answered !== null) {
        const specialAction = specialPlanInterviewAction(answered);
        if (specialAction === "chat_about_this") {
          return {
            content:
              "User wants to chat about these questions before answering. Continue conversationally, address their concern, and use AskUserQuestion again only if concrete choices are still needed.",
            codeModeResult: {
              questions: answered.questions,
              planInterviewAction: specialAction,
            },
          };
        }
        if (specialAction === "skip_plan_interview") {
          return {
            content:
              "User skipped the planning interview and wants you to plan immediately. Continue plan mode using the existing request and context, write or revise the plan file, then call ExitPlanMode when ready.",
            codeModeResult: {
              questions: answered.questions,
              planInterviewAction: specialAction,
            },
          };
        }
      }
      if (answered === null || Object.keys(answered.answers ?? {}).length === 0) {
        // A deliberate user skip (metadata.skipped set by the picker's esc)
        // is NOT an error: the model should proceed with its best judgment
        // instead of being told "no answers" and re-asking in a loop.
        if (answered?.metadata?.skipped === true) {
          return {
            content:
              "User skipped these questions. Proceed with your best judgment — do not ask the same questions again unless something new makes the answer truly blocking.",
            codeModeResult: {
              questions: answered.questions,
              skipped: true,
            },
          };
        }
        return {
          content: "User did not provide answers.",
          isError: true,
        };
      }
      const answers = answered.answers ?? {};
      return {
        content: `User has answered your questions: ${formatAnswers(
          answers,
          answered.annotations,
        )}. You can now continue with the user's answers in mind.`,
        codeModeResult: {
          questions: answered.questions,
          answers,
          ...(answered.annotations !== undefined
            ? { annotations: answered.annotations }
            : {}),
        },
      };
    },
  };
}
