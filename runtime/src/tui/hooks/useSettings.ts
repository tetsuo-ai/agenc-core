// AgenC useSettings shim.
//
// Wired into the markdown wholesale-port. openclaude's useSettings reads
// from their per-user settings store; AgenC has its own settings layer
// but markdown rendering currently consumes only one flag
// (syntaxHighlightingDisabled), and AgenC has no toggle for it today.
// This shim returns the defaults; if AgenC adds a syntax-highlight
// toggle later, replace the body with the real settings read.

export interface AgenCMarkdownSettings {
  readonly syntaxHighlightingDisabled: boolean;
}

export function useSettings(): AgenCMarkdownSettings {
  return { syntaxHighlightingDisabled: false };
}
