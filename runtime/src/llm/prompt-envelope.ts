import type { PromptBudgetSection } from "./prompt-budget.js";
import type { LLMMessage } from "./types.js";

export interface PromptSection {
  readonly source: string;
  readonly content: string;
}

export interface PromptEnvelopeV1 {
  readonly kind: "prompt_envelope_v1";
  readonly baseSystemPrompt: string;
  readonly systemSections: readonly PromptSection[];
  readonly userSections: readonly PromptSection[];
}

export type PromptEnvelopeInput =
  | PromptEnvelopeV1
  | {
      readonly baseSystemPrompt: string;
      readonly systemSections?: readonly PromptSection[];
      readonly userSections?: readonly PromptSection[];
    };

export const PROMPT_ENVELOPE_KIND_V1 = "prompt_envelope_v1";
export const USER_CONTEXT_MERGE_BOUNDARY = "user_context";

function normalizeSections(
  sections: readonly PromptSection[] | undefined,
): readonly PromptSection[] {
  if (!sections || sections.length === 0) return [];
  return sections
    .filter(
      (section): section is PromptSection =>
        typeof section?.source === "string" &&
        section.source.trim().length > 0 &&
        typeof section.content === "string" &&
        section.content.trim().length > 0,
    )
    .map((section) => ({
      source: section.source.trim(),
      content: section.content.trim(),
    }));
}

export function normalizePromptEnvelope(
  input: PromptEnvelopeInput,
): PromptEnvelopeV1 {
  if ("kind" in input && input.kind === PROMPT_ENVELOPE_KIND_V1) {
    return {
      kind: PROMPT_ENVELOPE_KIND_V1,
      baseSystemPrompt: input.baseSystemPrompt,
      systemSections: normalizeSections(input.systemSections),
      userSections: normalizeSections(input.userSections),
    };
  }

  return {
    kind: PROMPT_ENVELOPE_KIND_V1,
    baseSystemPrompt: input.baseSystemPrompt,
    systemSections: normalizeSections(input.systemSections),
    userSections: normalizeSections(input.userSections),
  };
}

export function createPromptEnvelope(
  baseSystemPrompt: string,
): PromptEnvelopeV1 {
  return normalizePromptEnvelope({
    baseSystemPrompt,
    systemSections: [],
    userSections: [],
  });
}

function mapSystemSectionToBudgetSection(
  source: string,
): PromptBudgetSection {
  switch (source) {
    case "memory_working":
      return "memory_working";
    case "memory_episodic":
      return "memory_episodic";
    case "memory_semantic":
      return "memory_semantic";
    default:
      return "system_runtime";
  }
}

export interface FlattenPromptEnvelopeTargetInput {
  readonly envelope: PromptEnvelopeV1;
}

export interface FlattenedPromptEnvelope {
  readonly messages: readonly LLMMessage[];
  readonly sections: readonly PromptBudgetSection[];
}

function buildUserContextContent(
  sections: readonly PromptSection[],
): string | undefined {
  if (sections.length === 0) return undefined;
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context:",
    ...sections.map((section) => `# ${section.source}\n${section.content}`),
    "",
    "IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
    "</system-reminder>",
  ].join("\n");
}

export function flattenPromptEnvelope(
  _target: "call" | "reconciliation",
  input: FlattenPromptEnvelopeTargetInput,
): FlattenedPromptEnvelope {
  const messages: LLMMessage[] = [];
  const sections: PromptBudgetSection[] = [];
  const envelope = normalizePromptEnvelope(input.envelope);

  if (envelope.baseSystemPrompt.trim().length > 0) {
    messages.push({
      role: "system",
      content: envelope.baseSystemPrompt,
    });
    sections.push("system_anchor");
  }

  for (const section of envelope.systemSections) {
    messages.push({
      role: "system",
      content: section.content,
    });
    sections.push(mapSystemSectionToBudgetSection(section.source));
  }

  const userContextContent = buildUserContextContent(envelope.userSections);
  if (userContextContent) {
    messages.push({
      role: "user",
      content: userContextContent,
      runtimeOnly: {
        mergeBoundary: USER_CONTEXT_MERGE_BOUNDARY,
      },
    });
    sections.push("user");
  }

  return { messages, sections };
}

export function stripRuntimeOnlyPromptMetadata(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  return messages.map((message) => {
    if (!message.runtimeOnly) return message;
    const { runtimeOnly: _runtimeOnly, ...rest } = message;
    return rest;
  });
}
