export interface ComposerSubmitHelpers {
  clearBuffer(): void;
  resetHistory(): void;
  setCursorOffset(offset: number): void;
}

export interface ElicitationSubmitTarget {
  submit(value: string): boolean;
}

function clearComposer(helpers: ComposerSubmitHelpers): void {
  helpers.clearBuffer();
  helpers.resetHistory();
  helpers.setCursorOffset(0);
}

export async function submitViaElicitationPrompt(
  elicitation: ElicitationSubmitTarget,
  submit: (value: string) => Promise<void>,
  value: string,
  helpers: ComposerSubmitHelpers,
): Promise<void> {
  const handledByElicitation = elicitation.submit(value);
  clearComposer(helpers);
  if (!handledByElicitation) {
    await submit(value);
  }
}
