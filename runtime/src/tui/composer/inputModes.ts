/**
 * Composer input-mode helpers.
 *
 * Extends the upstream mode enum with AgenC's two extra modes:
 *
 *   - `memory`    — `#` prefix appends the prompt text to AGENC.md.
 *                  The trigger character is stored as `#`; the actual
 *                  append target is resolved by
 *                  `runtime/src/prompts/project-instructions.ts` which
 *                  walks ancestors for the closest `AGENC.md`.
 *   - `resources` — reserved for the resource browser (apps/skills/MCP
 *                  inventory). No prefix character; entered explicitly
 *                  by the operator via slash command. Listed here so
 *                  history-mode and the mode switch type-check exhaustively.
 *
 * `bash` (`!`) keeps the upstream semantics exactly so history
 * rewriting lines up with the upstream history file format.
 */

export type PromptInputMode =
  | "prompt"
  | "bash"
  | "memory"
  | "resources"
  // Carry-overs from the upstream superset so consumers that branch on
  // task/orphan envelopes still type-check. The composer never enters
  // these modes itself — they show up only when an external caller
  // (queue replay, orphan-permission notifier) hands the composer a
  // pre-rendered notification.
  | "orphaned-permission"
  | "task-notification";

export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>;

/** History-mode tag used by arrow-key history scrubbing. */
export type HistoryMode = "prompt" | "bash" | "memory";

/**
 * Re-attach the mode prefix character to a buffer so the on-screen text
 * matches what the user typed. Called when a history entry is loaded
 * back into the composer.
 */
export function prependModeCharacterToInput(
  input: string,
  mode: PromptInputMode,
): string {
  switch (mode) {
    case "bash":
      return `!${input}`;
    case "memory":
      return `#${input}`;
    default:
      return input;
  }
}

/**
 * Detect the mode implied by the leading character of a buffer. Used by
 * the input-change handler to flip mode when the user types `!`/`#` at
 * the start of an empty composer.
 */
export function getModeFromInput(input: string): HistoryMode {
  if (input.startsWith("!")) {
    return "bash";
  }
  if (input.startsWith("#")) {
    return "memory";
  }
  return "prompt";
}

/**
 * Strip the mode prefix to recover the raw user text. Always called
 * before forwarding the buffer to the runtime so `!ls -la` becomes
 * `ls -la` and `#new note` becomes `new note`.
 */
export function getValueFromInput(input: string): string {
  const mode = getModeFromInput(input);
  if (mode === "prompt") {
    return input;
  }
  return input.slice(1);
}

/**
 * Cheap predicate the keystroke handler uses to decide whether to flip
 * mode on a single-char insertion at offset 0.
 */
export function isInputModeCharacter(input: string): boolean {
  return input === "!" || input === "#";
}
