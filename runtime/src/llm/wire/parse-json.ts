import { LLMInvalidResponseError } from "../errors.js";

export function parseProviderJson(
  providerName: string,
  raw: string,
  sourceLabel: string,
): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new LLMInvalidResponseError(
      providerName,
      `Malformed JSON in ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
