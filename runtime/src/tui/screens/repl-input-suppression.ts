/**
 * Composer input suppression predicate.
 *
 * Returns true when the prompt input has captured user attention — either
 * because the textinput is currently focused (`isPromptInputActive`) or
 * because the user has already started typing into it. The REPL screen
 * uses this signal to suppress startup gates and recommendation dialogs
 * that would otherwise steal focus during the early-typing window.
 */
export function isPromptTypingSuppressionActive(
  isPromptInputActive: boolean,
  inputValue: string,
): boolean {
  return isPromptInputActive || inputValue.trim().length > 0;
}
