export interface ComposerSubmitHelpers {
  clearBuffer(): void;
  resetHistory(): void;
  setCursorOffset(offset: number): void;
}

export interface ElicitationSubmitTarget {
  submit(value: string): boolean;
}

export interface ComposerSubmitOptions {
  readonly pastedContentsOverride?: Record<number, unknown>;
}

// The cursor is left alone: `submit` may keep the text (busy retry, an
// elicitation answer) or restore it after a rejection. When the owner does
// clear the text, PromptInput's input effect moves the cursor to 0.
function clearComposer(helpers: ComposerSubmitHelpers): void {
  helpers.clearBuffer();
  helpers.resetHistory();
}

export async function submitViaElicitationPrompt(
  elicitation: ElicitationSubmitTarget,
  submit: (value: string, options?: ComposerSubmitOptions) => Promise<void>,
  value: string,
  helpers: ComposerSubmitHelpers,
  options?: ComposerSubmitOptions,
): Promise<void> {
  const handledByElicitation = elicitation.submit(value);
  clearComposer(helpers);
  if (!handledByElicitation) {
    await submit(value, options);
  }
}
