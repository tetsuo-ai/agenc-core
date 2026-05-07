/**
 * Ports upstream runtime `core/src/context/personality_spec_instructions.rs`
 * and the model-message personality template helpers onto AgenC messages.
 *
 * Shape difference from upstream:
 *   - AgenC keeps the live system prompt outside the model catalog, so
 *     instruction templates may include a `{{ base_instructions }}`
 *     placeholder that is filled from the current assembled prompt.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Remote model metadata fetching owns wire deserialization; this module
 *     only resolves already-normalized template data.
 */

import type { LLMMessage } from "../llm/types.js";

export type Personality = "none" | "friendly" | "pragmatic";

export const PERSONALITY_PLACEHOLDER = "{{ personality }}";
export const BASE_INSTRUCTIONS_PLACEHOLDER = "{{ base_instructions }}";
export const PERSONALITY_SPEC_START_MARKER = "<personality_spec>";
export const PERSONALITY_SPEC_END_MARKER = "</personality_spec>";

export interface ModelInstructionsVariables {
  readonly personalityDefault?: string;
  readonly personalityFriendly?: string;
  readonly personalityPragmatic?: string;
}

export interface ModelMessages {
  readonly instructionsTemplate?: string;
  readonly instructionsVariables?: ModelInstructionsVariables;
}

export interface PersonalityModelInfo {
  readonly modelMessages?: ModelMessages;
}

export function normalizePersonality(
  value: string | undefined,
): Personality | undefined {
  switch (value) {
    case "none":
    case "friendly":
    case "pragmatic":
      return value;
    default:
      return undefined;
  }
}

export function modelSupportsPersonality(
  modelMessages: ModelMessages | undefined,
): boolean {
  return (
    modelMessages?.instructionsTemplate?.includes(PERSONALITY_PLACEHOLDER) ===
      true &&
    modelMessages.instructionsVariables?.personalityDefault !== undefined &&
    modelMessages.instructionsVariables.personalityFriendly !== undefined &&
    modelMessages.instructionsVariables.personalityPragmatic !== undefined
  );
}

export function personalityMessageForModel(
  modelInfo: PersonalityModelInfo,
  personality: Personality | undefined,
): string | undefined {
  const variables = modelInfo.modelMessages?.instructionsVariables;
  if (variables === undefined) return undefined;
  switch (personality) {
    case undefined:
      return variables.personalityDefault;
    case "none":
      return "";
    case "friendly":
      return variables.personalityFriendly;
    case "pragmatic":
      return variables.personalityPragmatic;
  }
}

export function getModelInstructions(input: {
  readonly modelInfo: PersonalityModelInfo;
  readonly baseInstructions: string;
  readonly personality?: Personality;
}): string {
  const template = input.modelInfo.modelMessages?.instructionsTemplate;
  if (template === undefined) {
    return input.baseInstructions;
  }
  const personalityMessage =
    personalityMessageForModel(input.modelInfo, input.personality) ?? "";
  return template
    .replaceAll(PERSONALITY_PLACEHOLDER, personalityMessage)
    .replaceAll(BASE_INSTRUCTIONS_PLACEHOLDER, input.baseInstructions);
}

export function renderPersonalitySpecBody(spec: string): string {
  return ` The user has requested a new communication style. Future messages should adhere to the following personality: \n${spec} `;
}

export function renderPersonalitySpecInstructions(spec: string): string {
  return `${PERSONALITY_SPEC_START_MARKER}${renderPersonalitySpecBody(spec)}${PERSONALITY_SPEC_END_MARKER}`;
}

export function personalitySpecInstructionMessage(spec: string): LLMMessage {
  return {
    role: "developer",
    content: [{ type: "text", text: renderPersonalitySpecInstructions(spec) }],
  };
}

export function startsWithPersonalitySpecOpenTag(text: string): boolean {
  return text.trimStart().startsWith(PERSONALITY_SPEC_START_MARKER);
}
