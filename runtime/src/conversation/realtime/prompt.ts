import { userInfo } from "node:os";

import backendPrompt from "./prompts/backend_prompt.md";
import realtimeEndPrompt from "./prompts/realtime_end.md";
import realtimeStartPrompt from "./prompts/realtime_start.md";

/**
 * Parity anchors: `core/src/realtime_prompt.rs` plus the realtime prompt
 * markdown assets at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.
 */
export const REALTIME_USER_FIRST_NAME_PLACEHOLDER = "{{ user_first_name }}";
const DEFAULT_REALTIME_USER_FIRST_NAME = "there";

export const DEFAULT_REALTIME_BACKEND_PROMPT: string = backendPrompt;
export const DEFAULT_REALTIME_START_INSTRUCTIONS: string = realtimeStartPrompt;
export const DEFAULT_REALTIME_END_INSTRUCTIONS: string = realtimeEndPrompt;

export interface RealtimeUserFirstNameOptions {
  readonly candidates?: readonly (string | null | undefined)[];
}

export function prepareRealtimeBackendPrompt(
  prompt: string | null | undefined,
  configPrompt?: string | null,
  options: RealtimeUserFirstNameOptions = {},
): string {
  if (typeof configPrompt === "string" && configPrompt.trim().length > 0) {
    return configPrompt;
  }
  if (prompt !== undefined) {
    return prompt ?? "";
  }
  return DEFAULT_REALTIME_BACKEND_PROMPT.trimEnd().replaceAll(
    REALTIME_USER_FIRST_NAME_PLACEHOLDER,
    currentRealtimeUserFirstName(options),
  );
}

export function currentRealtimeUserFirstName(
  options: RealtimeUserFirstNameOptions = {},
): string {
  return (
    firstNameFromCandidates(
      options.candidates ?? defaultRealtimeUserNameCandidates(),
    ) ?? DEFAULT_REALTIME_USER_FIRST_NAME
  );
}

function defaultRealtimeUserNameCandidates(): readonly (string | null | undefined)[] {
  return [
    process.env.FULLNAME,
    process.env.NAME,
    process.env.REALNAME,
    safeUserInfoUsername(),
    process.env.USER,
    process.env.USERNAME,
    process.env.LOGNAME,
  ];
}

function firstNameFromCandidates(
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const firstName = trimmed.split(/\s+/u)[0];
    if (firstName !== undefined && firstName.length > 0) return firstName;
  }
  return null;
}

function safeUserInfoUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}
