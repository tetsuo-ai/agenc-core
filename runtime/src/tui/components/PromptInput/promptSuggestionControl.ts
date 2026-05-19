export function getVisiblePromptSuggestion({
  inputValue,
  isAssistantResponding,
  suggestionText,
}: {
  inputValue: string;
  isAssistantResponding: boolean;
  suggestionText: string | null;
}): string | null {
  return isAssistantResponding || inputValue.length > 0 ? null : suggestionText;
}

export function computePromptSuggestionOutcome({
  acceptedAt,
  finalInput,
  now,
  shownAt,
  suggestionText,
}: {
  acceptedAt: number;
  finalInput: string;
  now: number;
  shownAt: number;
  suggestionText: string | null;
}): {
  wasAccepted: boolean;
  tabWasPressed: boolean;
  timeMs: number;
  similarity: number;
} | null {
  if (!suggestionText || shownAt <= 0) return null;
  const tabWasPressed = acceptedAt > shownAt;
  const wasAccepted = tabWasPressed || finalInput === suggestionText;
  const timeMs = wasAccepted ? acceptedAt || now : now;
  return {
    wasAccepted,
    tabWasPressed,
    timeMs,
    similarity: Math.round((finalInput.length / suggestionText.length) * 100) / 100,
  };
}

export function shouldShowPromptSuggestionPlaceholder({
  mode,
  promptSuggestion,
  suggestionCount,
  viewingAgentTaskId,
}: {
  mode: string;
  promptSuggestion: string | null;
  suggestionCount: number;
  viewingAgentTaskId?: string | null;
}): boolean {
  return mode === 'prompt' && suggestionCount === 0 && Boolean(promptSuggestion) && !viewingAgentTaskId;
}

export function shouldSuppressPromptSuggestionForTiming({
  promptSuggestionText,
  visiblePromptSuggestion,
  shownAt,
  viewingAgentTaskId,
}: {
  promptSuggestionText: string | null;
  visiblePromptSuggestion: string | null;
  shownAt: number;
  viewingAgentTaskId?: string | null;
}): boolean {
  return Boolean(promptSuggestionText) &&
    !visiblePromptSuggestion &&
    shownAt === 0 &&
    !viewingAgentTaskId;
}
