/**
 * Lean stubs for the display/UI helpers `manual-compact.ts` reaches for
 * when assembling the post-compact stdout breadcrumb.
 *
 * The openclaude versions hook a keybindings store and a model-upgrade
 * tip resolver. The gut runtime does not own those; manual-compact only
 * needs them to assemble informational text. Returning the fallback /
 * `null` here keeps the message coherent without dragging the
 * keybindings or model-upgrade subsystems into the gut.
 */

export function getShortcutDisplay(
  _action: string,
  _context: string,
  fallback: string,
): string {
  return fallback;
}

export function getUpgradeMessage(_context: "warning" | "tip"): string | null {
  return null;
}
