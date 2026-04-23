/**
 * Local stub for openclaude `utils/cliHighlight.ts`.
 *
 * The gut TUI uses `getCliHighlightPromise` to optionally light up code
 * blocks in markdown rendering. Returning `null` means the markdown
 * pipeline falls back to plain (un-highlighted) text — that is the
 * documented contract in `render/code-highlight.ts`.
 */

export type CliHighlight = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  highlight: (code: string, opts?: any) => string;
  supportsLanguage: (language: string) => boolean;
};

let cliHighlightPromise: Promise<CliHighlight | null> | undefined;

async function loadCliHighlight(): Promise<CliHighlight | null> {
  const previousForceColor = process.env.FORCE_COLOR;
  if (previousForceColor === undefined || previousForceColor.length === 0) {
    process.env.FORCE_COLOR = "1";
  }
  try {
    // Dynamic import keeps cli-highlight optional at runtime; if it isn't
    // installed, we silently fall back to plain rendering.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("cli-highlight").catch(() => null);
    if (!mod) return null;
    return {
      highlight: mod.highlight,
      supportsLanguage: mod.supportsLanguage,
    };
  } catch {
    return null;
  } finally {
    if (previousForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = previousForceColor;
    }
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight();
  return cliHighlightPromise;
}
