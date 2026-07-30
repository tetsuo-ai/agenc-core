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
  readonly onWorkbenchAttachmentsAdmitted?: () => void;
}

function clearComposer(helpers: ComposerSubmitHelpers): void {
  helpers.clearBuffer();
  helpers.resetHistory();
  helpers.setCursorOffset(0);
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
