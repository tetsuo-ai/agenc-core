export interface ComposerSubmitHelpers {
  clearBuffer(): void;
  resetHistory(): void;
  setCursorOffset(offset: number): void;
}

export interface ElicitationSubmitRouter {
  submit(value: string): boolean;
}

export async function submitViaElicitationBridge(
  elicitation: ElicitationSubmitRouter,
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
