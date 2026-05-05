export interface ComposerSubmitHelpers {
  clearBuffer(): void;
  resetHistory(): void;
  setCursorOffset(offset: number): void;
}

export interface ElicitationSubmitTarget {
  submit(value: string): boolean;
}

export async function submitViaElicitationPrompt(
  elicitation: ElicitationSubmitTarget,
  submit: (value: string) => Promise<void>,
  value: string,
  helpers: ComposerSubmitHelpers,
): Promise<void> {
  if (!elicitation.submit(value)) {
    await submit(value);
  }
  helpers.clearBuffer();
  helpers.resetHistory();
  helpers.setCursorOffset(0);
}
