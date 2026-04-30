// Cherry-picked editor adapter for the wholesale-ported search dialogs.
//
// openclaude src/utils/editor.ts (~183 LOC) opens files in the user's
// $EDITOR (or VS Code via 'code -g') and waits for it to close. AgenC
// has its own external-editor wiring under runtime/src/tui/composer/
// for $EDITOR composer hand-off; this shim provides a no-op
// openFileInExternalEditor matching openclaude's API surface so the
// dialog compiles. Wire to AgenC's editor-launch path when the search
// dialogs become production consumers.

export async function openFileInExternalEditor(
  _filePath: string,
  _options: { line?: number; column?: number } = {},
): Promise<void> {
  // No-op shim. AgenC consumers replace this body to invoke their
  // real editor-launch path.
}
