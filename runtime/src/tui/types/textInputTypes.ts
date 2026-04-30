// Cherry-picked PromptInputMode for the wholesale-ported
// useHistorySearch hook.
//
// openclaude src/types/textInputTypes.ts (~389 LOC) declares the
// composer/PromptInput type universe. The wholesale-ported search
// hooks consume only PromptInputMode; the rest stays in openclaude
// until the composer wholesale-port lifts more of it over.

// Cherry-picked PromptInputMode (verbatim from openclaude src/types/textInputTypes.ts).
export type PromptInputMode =
  | "bash"
  | "prompt"
  | "orphaned-permission"
  | "task-notification";

export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>;
