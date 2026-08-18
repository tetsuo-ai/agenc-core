import type { KeybindingContextName } from "../../keybindings/types.js";

import type { BufferProviderSnapshot } from "./providers/types.js";

export type BufferKeybindingContext = Extract<
  KeybindingContextName,
  "Buffer" | "BufferHost"
>;

/**
 * Select the keybinding vocabulary for the current BUFFER input owner.
 *
 * Before any provider has opened a file, the empty Editor surface is host UI:
 * the controller's initial inline identity is only a placeholder and must not
 * make the empty surface advertise or require inline-editor chords. Once a
 * provider owns a file, its terminal capability selects between Neovim host
 * escape hatches and the inline fallback's existing key vocabulary.
 */
export function bufferKeybindingContext(
  snapshot: Pick<
    BufferProviderSnapshot,
    "filePath" | "provider" | "providerStatus"
  >,
): BufferKeybindingContext {
  const emptyHostSurface = snapshot.filePath === null;
  return snapshot.provider.capabilities.terminalUi || emptyHostSurface
    ? "BufferHost"
    : "Buffer";
}
